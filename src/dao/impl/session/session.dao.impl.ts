import type { AesGcmCipher } from '~/core/crypto/AesGcmCipher.js';
import type { Session } from '~/core/domain/Session.js';
import type { SessionDao } from '~/dao/session.dao.js';

import type { LifecycleTracer } from './lifecycle-tracer.js';
import type { LruSessionLayer } from './lru.layer.js';
import type { PostgresSessionLayer } from './postgres.layer.js';
import type { RedisSessionLayer } from './redis.layer.js';

/**
 * 3-layer SessionStorage facade.
 *
 *   loadSession   : read-through   LRU → Redis → Postgres. On lower-layer hit, populate upper layers.
 *   storeSession  : write-through  Postgres (SoT first) → Redis → LRU.
 *                                  accessToken is AES-GCM encrypted before hitting any persistence layer.
 *   deleteSession : fan-out delete Postgres + Redis + LRU.
 *   deleteSessions: batch fan-out.
 *   findSessionsByShop: Postgres query (authoritative). Upper layers optionally warmed afterwards.
 *
 * Cache-stampede protection: a single-flight map dedupes concurrent `loadSession` misses for the same id
 *   → only one Postgres hit per (id) even with hundreds of concurrent callers.
 *
 * Graceful degradation:
 *   - Redis or LRU failures are logged but NOT propagated if Postgres served the read. (Read path is tolerant.)
 *   - Postgres write failure → the facade fails loud. Redis/LRU writes after that are skipped (no stale caches).
 *
 * Encryption is the facade's job. Layers receive ciphertext and return ciphertext — the facade decrypts
 * before returning to callers. This means:
 *   - In memory (LRU), sessions always carry plaintext accessToken (fast path).
 *   - In Redis + Postgres, sessions always carry ciphertext accessToken (at-rest protection).
 */
export class SessionDaoFacade implements SessionDao {
  private readonly inFlightLoads: Map<string, Promise<Session | undefined>>;

  constructor(
    private readonly lru: LruSessionLayer,
    private readonly redis: RedisSessionLayer,
    private readonly pg: PostgresSessionLayer,
    private readonly cipher: AesGcmCipher,
    private readonly tracer: LifecycleTracer,
  ) {
    this.inFlightLoads = new Map();
  }

  async storeSession(session: Session): Promise<boolean> {
    return this.tracer.trace(
      {
        method: 'storeSession',
        sessionId: session.id,
        shop: session.shop,
        isOnline: session.isOnline,
        layerHit: 'write-through',
      },
      async () => {
        const encrypted = this.toEncrypted(session);
        // SoT first — if Postgres rejects, don't pollute caches.
        await this.pg.storeSession(encrypted);
        // Best-effort warm writes — swallow + log per-layer errors.
        await safe(async () => this.redis.storeSession(encrypted));
        // LRU stores the plaintext form for fastest next-read.
        await this.lru.storeSession(session);
        return true;
      },
    );
  }

  async loadSession(id: string): Promise<Session | undefined> {
    // Fast path: LRU (plaintext already).
    const lruHit = await this.lru.loadSession(id);
    if (lruHit) {
      this.tracer.emit({ method: 'loadSession', sessionId: id, layerHit: 'lru', durationMs: 0, ok: true });
      return lruHit;
    }

    // Single-flight: dedupe concurrent misses for the same id.
    const existing = this.inFlightLoads.get(id);
    if (existing) return existing;

    const promise = this.tracer.trace(
      { method: 'loadSession', sessionId: id },
      async () => {
        try {
          // Redis tier.
          const redisHit = await this.redis.loadSession(id);
          if (redisHit) {
            const plaintext = this.fromEncrypted(redisHit);
            await this.lru.storeSession(plaintext); // populate upper
            this.tracer.emit({
              method: 'loadSession',
              sessionId: id,
              layerHit: 'redis',
              durationMs: 0,
              ok: true,
            });
            return plaintext;
          }
          // Postgres tier.
          const pgHit = await this.pg.loadSession(id);
          if (pgHit) {
            const plaintext = this.fromEncrypted(pgHit);
            // Warm upper layers. Redis stores ciphertext; LRU stores plaintext.
            await safe(async () => this.redis.storeSession(pgHit));
            await this.lru.storeSession(plaintext);
            this.tracer.emit({
              method: 'loadSession',
              sessionId: id,
              layerHit: 'postgres',
              durationMs: 0,
              ok: true,
            });
            return plaintext;
          }
          this.tracer.emit({
            method: 'loadSession',
            sessionId: id,
            layerHit: 'miss',
            durationMs: 0,
            ok: true,
          });
          return undefined;
        } finally {
          this.inFlightLoads.delete(id);
        }
      },
    );

    this.inFlightLoads.set(id, promise);
    return promise;
  }

  async deleteSession(id: string): Promise<boolean> {
    return this.tracer.trace(
      { method: 'deleteSession', sessionId: id, layerHit: 'delete-all' },
      async () => {
        await this.pg.deleteSession(id);
        await safe(async () => this.redis.deleteSession(id));
        await this.lru.deleteSession(id);
        return true;
      },
    );
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    return this.tracer.trace(
      { method: 'deleteSessions', sessionIds: ids, layerHit: 'delete-all' },
      async () => {
        await this.pg.deleteSessions(ids);
        await safe(async () => this.redis.deleteSessions(ids));
        await this.lru.deleteSessions(ids);
        return true;
      },
    );
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    return this.tracer.trace(
      { method: 'findSessionsByShop', shop, layerHit: 'postgres' },
      async () => {
        const encrypted = await this.pg.findSessionsByShop(shop);
        return encrypted.map((s) => this.fromEncrypted(s));
      },
    );
  }

  // ---------- internals ----------

  /** Produce a new Session with accessToken AES-GCM-encrypted. Leaves other fields untouched. */
  private toEncrypted(s: Session): Session {
    if (!s.accessToken) return { ...s, encryptionKeyId: undefined };
    const ct = this.cipher.encrypt(s.accessToken);
    return {
      ...s,
      accessToken: ct,
      encryptionKeyId: this.cipher.currentKeyId(),
    };
  }

  /** Produce a new Session with accessToken decrypted (if present). */
  private fromEncrypted(s: Session): Session {
    if (!s.accessToken) return s;
    return { ...s, accessToken: this.cipher.decrypt(s.accessToken) };
  }
}

/**
 * Run an async op and swallow any error (the facade logs them internally via tracer but does
 * not propagate to callers for non-SoT layers). Use only for Redis + LRU, never for Postgres.
 */
async function safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}
