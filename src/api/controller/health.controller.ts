import type { FastifyInstance } from 'fastify';

/**
 * Liveness (health) + readiness endpoints.
 * - /health  → process is up (no downstream checks)
 * - /readyz  → all downstream deps reachable (Postgres, Redis, optional Mongo)
 *             (readiness wiring lands in a later task when the DAO layer exists)
 */
export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ status: 'ok', service: 'kace-commerce-engine' }));

  app.get('/readyz', async () => ({
    status: 'ok',
    checks: { postgres: 'pending', redis: 'pending', mongo: 'n/a' },
  }));
}
