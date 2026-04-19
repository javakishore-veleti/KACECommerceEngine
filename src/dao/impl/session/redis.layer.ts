import type { Redis } from 'ioredis';

import type { Session } from '~/core/domain/Session.js';
import type { SessionDao } from '~/dao/session.dao.js';

/**
 * Redis warm-cache layer. Shared across all KACE instances (unlike LRU which is per-process).
 *
 * Keys:
 *   kace:session:{id}             → JSON blob of the Session (with accessToken already encrypted by the facade)
 *   kace:shop:{shop}:sessions     → SET of session ids belonging to that shop
 *
 * TTL: configurable per-write via `ttlSeconds`. Default 1h. Offline sessions may want longer (weeks).
 *
 * Encryption: this layer stores whatever the facade gives it — it does NOT encrypt/decrypt itself.
 * The facade is responsible for encrypting accessToken before calling storeSession and decrypting
 * after loadSession. This keeps the layer's invariants simple (pure read/write).
 */
export class RedisSessionLayer implements SessionDao {
  private readonly sessionKey = (id: string): string => `kace:session:${id}`;
  private readonly shopSetKey = (shop: string): string => `kace:shop:${shop}:sessions`;

  constructor(
    private readonly redis: Redis,
    private readonly defaultTtlSeconds: number,
  ) {}

  async storeSession(session: Session): Promise<boolean> {
    const key = this.sessionKey(session.id);
    const payload = JSON.stringify(serialize(session));
    // Use pipeline so SET and SADD land atomically from the caller's POV.
    const pipe = this.redis.pipeline();
    pipe.set(key, payload, 'EX', this.defaultTtlSeconds);
    pipe.sadd(this.shopSetKey(session.shop), session.id);
    // Best-effort: expire the shop set slightly later than any single session, so a
    // brand-new shop with one session doesn't orphan its set.
    pipe.expire(this.shopSetKey(session.shop), this.defaultTtlSeconds * 2);
    const results = await pipe.exec();
    return Boolean(results);
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const raw = await this.redis.get(this.sessionKey(id));
    if (!raw) return undefined;
    return deserialize(JSON.parse(raw));
  }

  async deleteSession(id: string): Promise<boolean> {
    const raw = await this.redis.get(this.sessionKey(id));
    const shop = raw ? (deserialize(JSON.parse(raw)).shop ?? null) : null;
    const pipe = this.redis.pipeline();
    pipe.del(this.sessionKey(id));
    if (shop) pipe.srem(this.shopSetKey(shop), id);
    await pipe.exec();
    return true;
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    if (ids.length === 0) return true;
    // Fetch first so we can update shop sets too. (One extra round-trip; still fast.)
    const keys = ids.map((id) => this.sessionKey(id));
    const rawRows = await this.redis.mget(...keys);
    const pipe = this.redis.pipeline();
    pipe.del(...keys);
    for (let i = 0; i < ids.length; i++) {
      const raw = rawRows[i];
      if (!raw) continue;
      const s = deserialize(JSON.parse(raw));
      const sessionId = ids[i];
      if (sessionId !== undefined) {
        pipe.srem(this.shopSetKey(s.shop), sessionId);
      }
    }
    await pipe.exec();
    return true;
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    const ids = await this.redis.smembers(this.shopSetKey(shop));
    if (ids.length === 0) return [];
    const rawRows = await this.redis.mget(...ids.map(this.sessionKey));
    const out: Session[] = [];
    for (const raw of rawRows) {
      if (raw) out.push(deserialize(JSON.parse(raw)));
    }
    return out;
  }
}

/** JSON-safe wire format: Dates as ISO strings. */
interface WireSession extends Omit<Session, 'expires' | 'createdAt' | 'updatedAt'> {
  expires?: string;
  createdAt?: string;
  updatedAt?: string;
}

function serialize(s: Session): WireSession {
  return {
    ...s,
    expires: s.expires ? s.expires.toISOString() : undefined,
    createdAt: s.createdAt ? s.createdAt.toISOString() : undefined,
    updatedAt: s.updatedAt ? s.updatedAt.toISOString() : undefined,
  };
}

function deserialize(w: WireSession): Session {
  return {
    ...w,
    expires: w.expires ? new Date(w.expires) : undefined,
    createdAt: w.createdAt ? new Date(w.createdAt) : undefined,
    updatedAt: w.updatedAt ? new Date(w.updatedAt) : undefined,
  };
}
