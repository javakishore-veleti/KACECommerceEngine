import Fastify from 'fastify';

import { registerHealthRoutes } from '~/api/controller/health.controller.js';
import { loadEnv } from '~/config/env.js';
import { buildFastifyLoggerOptions } from '~/observability/logger.js';

/**
 * Fastify bootstrap.
 * Workflow/DI wiring lands in later tasks once the DAO + service layers are populated.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const app = Fastify({ logger: buildFastifyLoggerOptions(env), trustProxy: true });

  await registerHealthRoutes(app);

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    app.log.info({ port: env.PORT, env: env.NODE_ENV }, 'KACECommerceEngine listening');
  } catch (err) {
    app.log.fatal({ err }, 'Failed to start KACECommerceEngine');
    process.exit(1);
  }
}

void main();
