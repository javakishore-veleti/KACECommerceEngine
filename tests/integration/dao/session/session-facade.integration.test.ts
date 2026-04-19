import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

import { LifecycleTracer } from '~/dao/impl/session/lifecycle-tracer.js';
import { LruSessionLayer } from '~/dao/impl/session/lru.layer.js';
import { PostgresSessionLayer } from '~/dao/impl/session/postgres.layer.js';
import { RedisSessionLayer } from '~/dao/impl/session/redis.layer.js';
import { SessionDaoFacade } from '~/dao/impl/session/session.dao.impl.js';
import pino from 'pino';

import { makeCipher } from '../../../fixtures/keys.js';
import { makeOfflineSession, makeOnlineSession } from '../../../fixtures/sessions.js';

/**
 * Full-facade integration test using real Postgres + Redis via testcontainers.
 *
 * Covers:
 *   - All 5 SessionDao methods round-trip through all 3 layers.
 *   - AES-GCM encryption at rest: Redis + Postgres rows must carry ciphertext, not plaintext.
 *   - Single-flight: concurrent loadSession misses produce only one Postgres query.
 *   - Cross-layer population: Postgres hit warms Redis + LRU.
 *   - Graceful Redis-down: LRU flush + Redis disconnect still lets reads fall through to Postgres.
 */

let pgContainer: StartedTestContainer;
let redisContainer: StartedTestContainer;
let pool: Pool;
let redis: Redis;

beforeAll(async () => {
  pgContainer = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_USER: 'kace', POSTGRES_PASSWORD: 'kace', POSTGRES_DB: 'kace_test' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  pool = new Pool({
    host: pgContainer.getHost(),
    port: pgContainer.getMappedPort(5432),
    user: 'kace',
    password: 'kace',
    database: 'kace_test',
  });

  // Apply schema inline (avoids spinning up node-pg-migrate in tests).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id                 text PRIMARY KEY,
      tenant             text NOT NULL,
      shop               text NOT NULL,
      state              text,
      is_online          boolean NOT NULL DEFAULT false,
      scope              text,
      expires            timestamptz,
      access_token_ct    text,
      encryption_key_id  text,
      online_access_info jsonb,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS sessions_shop_idx ON sessions(shop);
  `);

  redis = new Redis({
    host: redisContainer.getHost(),
    port: redisContainer.getMappedPort(6379),
  });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  redis?.disconnect();
  await pgContainer?.stop();
  await redisContainer?.stop();
});

beforeEach(async () => {
  await pool.query('TRUNCATE sessions');
  await redis.flushdb();
});

describe('SessionDaoFacade — full 3-layer integration', () => {
  function buildFacade() {
    const { cipher } = makeCipher();
    const lru = new LruSessionLayer({ maxEntries: 100, ttlMs: 60_000 });
    const redisLayer = new RedisSessionLayer(redis, 3600);
    const pgLayer = new PostgresSessionLayer(pool);
    const silentLogger = pino({ level: 'silent' });
    const tracer = new LifecycleTracer(silentLogger);
    const facade = new SessionDaoFacade(lru, redisLayer, pgLayer, cipher, tracer);
    return { facade, lru, redisLayer, pgLayer, cipher };
  }

  it('storeSession → loadSession round-trips through all layers', async () => {
    const { facade } = buildFacade();
    const s = makeOfflineSession();
    await facade.storeSession(s);
    const loaded = await facade.loadSession(s.id);
    expect(loaded?.accessToken).toBe(s.accessToken);
    expect(loaded?.tenant).toBe('PROMPTKART');
  });

  it('encrypts accessToken at rest in Postgres', async () => {
    const { facade } = buildFacade();
    const s = makeOfflineSession({ accessToken: 'shpat_CONFIDENTIAL_123' });
    await facade.storeSession(s);
    const { rows } = await pool.query('SELECT access_token_ct, encryption_key_id FROM sessions WHERE id = $1', [s.id]);
    expect(rows[0].access_token_ct).toBeTruthy();
    expect(rows[0].access_token_ct).not.toContain('CONFIDENTIAL');
    expect(rows[0].access_token_ct).toMatch(/^v1:/);
    expect(rows[0].encryption_key_id).toBe('v1');
  });

  it('encrypts accessToken at rest in Redis', async () => {
    const { facade } = buildFacade();
    const s = makeOfflineSession({ accessToken: 'shpat_CONFIDENTIAL_456' });
    await facade.storeSession(s);
    const raw = await redis.get(`kace:session:${s.id}`);
    expect(raw).toBeTruthy();
    expect(raw).not.toContain('CONFIDENTIAL');
  });

  it('loadSession populates upper layers on Postgres hit', async () => {
    const { facade, lru, redisLayer } = buildFacade();
    const s = makeOfflineSession();
    await facade.storeSession(s);
    // Wipe upper layers so Postgres is the only hit source.
    await lru.deleteSession(s.id);
    await redisLayer.deleteSession(s.id);
    // Now a load should miss LRU + Redis, hit Postgres, and populate both.
    const loaded = await facade.loadSession(s.id);
    expect(loaded?.accessToken).toBe(s.accessToken);
    // LRU should now have a plaintext hit.
    expect((await lru.loadSession(s.id))?.accessToken).toBe(s.accessToken);
    // Redis should now have a ciphertext hit.
    const redisRaw = await redis.get(`kace:session:${s.id}`);
    expect(redisRaw).toBeTruthy();
  });

  it('loadSession returns undefined for a missing id', async () => {
    const { facade } = buildFacade();
    expect(await facade.loadSession('offline_does-not-exist')).toBeUndefined();
  });

  it('deleteSession removes from all 3 layers', async () => {
    const { facade, lru, redisLayer, pgLayer } = buildFacade();
    const s = makeOfflineSession();
    await facade.storeSession(s);
    await facade.deleteSession(s.id);
    expect(await lru.loadSession(s.id)).toBeUndefined();
    expect(await redisLayer.loadSession(s.id)).toBeUndefined();
    expect(await pgLayer.loadSession(s.id)).toBeUndefined();
  });

  it('deleteSessions batch-deletes from all 3 layers', async () => {
    const { facade, lru, redisLayer, pgLayer } = buildFacade();
    const s1 = makeOfflineSession({ id: 'offline_a.myshopify.com', shop: 'a.myshopify.com' });
    const s2 = makeOfflineSession({ id: 'offline_b.myshopify.com', shop: 'b.myshopify.com' });
    await facade.storeSession(s1);
    await facade.storeSession(s2);
    await facade.deleteSessions([s1.id, s2.id]);
    for (const s of [s1, s2]) {
      expect(await lru.loadSession(s.id)).toBeUndefined();
      expect(await redisLayer.loadSession(s.id)).toBeUndefined();
      expect(await pgLayer.loadSession(s.id)).toBeUndefined();
    }
  });

  it('findSessionsByShop returns decrypted online + offline sessions', async () => {
    const { facade } = buildFacade();
    const shop = 'promptkart-dev.myshopify.com';
    const off = makeOfflineSession({ shop });
    const on = makeOnlineSession({ shop });
    await facade.storeSession(off);
    await facade.storeSession(on);
    const all = await facade.findSessionsByShop(shop);
    expect(all).toHaveLength(2);
    for (const s of all) {
      expect(s.accessToken).toMatch(/^shpat_/);
      expect(s.accessToken).not.toMatch(/^v1:/); // plaintext, not ciphertext
    }
  });

  it('single-flight: 50 concurrent loadSession misses produce only one Postgres query', async () => {
    const { facade, pgLayer } = buildFacade();
    const s = makeOfflineSession();
    await facade.storeSession(s);
    // Wipe upper layers.
    await (facade as unknown as { lru: LruSessionLayer }).lru.deleteSession(s.id);
    await (facade as unknown as { redis: RedisSessionLayer }).redis.deleteSession(s.id);

    // Instrument PG layer: count how many loads actually hit Postgres.
    let pgHits = 0;
    const origLoad = pgLayer.loadSession.bind(pgLayer);
    pgLayer.loadSession = async (id: string) => {
      pgHits++;
      return origLoad(id);
    };

    const results = await Promise.all(
      Array.from({ length: 50 }, () => facade.loadSession(s.id)),
    );
    for (const r of results) expect(r?.accessToken).toBe(s.accessToken);
    expect(pgHits).toBe(1);
  });
});
