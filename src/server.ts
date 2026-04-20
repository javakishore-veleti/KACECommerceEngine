import 'dotenv/config';

import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import pino from 'pino';

import { registerHealthRoutes } from '~/api/controller/health.controller.js';
import { registerShopifyOAuthRoutes } from '~/api/controller/shopify-oauth.controller.js';
import { loadEnv } from '~/config/env.js';
import { createShopifyApi } from '~/config/shopify.config.js';
import { AesGcmCipher } from '~/core/crypto/AesGcmCipher.js';
import { EnvKeyProvider } from '~/core/crypto/KeyProvider.js';
import { LifecycleTracer } from '~/dao/impl/session/lifecycle-tracer.js';
import { LruSessionLayer } from '~/dao/impl/session/lru.layer.js';
import { PostgresSessionLayer } from '~/dao/impl/session/postgres.layer.js';
import { RedisSessionLayer } from '~/dao/impl/session/redis.layer.js';
import { SessionDaoFacade } from '~/dao/impl/session/session.dao.impl.js';
import { ShopifySessionStorageAdapter } from '~/dao/impl/session/shopify-session-storage.adapter.js';
import { buildFastifyLoggerOptions } from '~/observability/logger.js';
import { ShopifyInstallServiceImpl } from '~/service/impl/shopify-install.service.impl.js';

/**
 * Fastify bootstrap + manual DI wiring.
 * Every concrete dep is constructed once here and passed down by interface.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const app = Fastify({ logger: buildFastifyLoggerOptions(env), trustProxy: true });

  // ---- data layer ----
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    min: env.POSTGRES_POOL_MIN,
    max: env.POSTGRES_POOL_MAX,
  });
  const redis = new Redis(env.REDIS_URL);

  // ---- crypto ----
  const keyMap: Record<string, string> = { [env.ENCRYPTION_KEY_ID]: env.ENCRYPTION_KEY_V1 };
  if (env.ENCRYPTION_KEY_V2) keyMap.v2 = env.ENCRYPTION_KEY_V2;
  if (env.ENCRYPTION_KEY_V3) keyMap.v3 = env.ENCRYPTION_KEY_V3;
  // Ensure current key's env var matches the ENCRYPTION_KEY_ID name if non-default
  if (!(env.ENCRYPTION_KEY_ID in keyMap)) keyMap[env.ENCRYPTION_KEY_ID] = env.ENCRYPTION_KEY_V1;
  const cipher = new AesGcmCipher(new EnvKeyProvider({ currentId: env.ENCRYPTION_KEY_ID, keys: keyMap }));

  // ---- session facade + Shopify adapter ----
  const tracerLogger = pino({ level: env.LOG_LEVEL });
  const tracer = new LifecycleTracer(tracerLogger);
  const sessionFacade = new SessionDaoFacade(
    new LruSessionLayer({ maxEntries: env.LRU_MAX, ttlMs: env.LRU_TTL_MS }),
    new RedisSessionLayer(redis, env.REDIS_SESSION_TTL_S),
    new PostgresSessionLayer(pool),
    cipher,
    tracer,
  );
  const shopifySessionStorage = new ShopifySessionStorageAdapter(sessionFacade, env.SHOPIFY_DEFAULT_TENANT);

  // ---- Shopify API ----
  const shopify = createShopifyApi(env);
  const installService = new ShopifyInstallServiceImpl(shopify, shopifySessionStorage, tracerLogger);

  // ---- routes ----
  await registerHealthRoutes(app);
  await registerShopifyOAuthRoutes(app, installService);

  // ---- lifecycle ----
  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await pool.end();
    redis.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    app.log.info(
      { port: env.PORT, env: env.NODE_ENV, shopifyAppUrl: env.SHOPIFY_APP_URL },
      'KACECommerceEngine listening. OAuth begin at GET /auth?shop=<shop>.myshopify.com',
    );
  } catch (err) {
    app.log.fatal({ err }, 'Failed to start KACECommerceEngine');
    process.exit(1);
  }
}

void main();
