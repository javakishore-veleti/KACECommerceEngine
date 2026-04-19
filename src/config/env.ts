import { z } from 'zod';

/**
 * Zod-validated environment loader. Fails fast at boot if anything is missing or malformed.
 * This file is the one place env vars are read — everywhere else, inject the parsed `Env` object.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // Postgres
  DATABASE_URL: z.string().url(),
  POSTGRES_POOL_MIN: z.coerce.number().int().nonnegative().default(2),
  POSTGRES_POOL_MAX: z.coerce.number().int().positive().default(10),

  // Redis
  REDIS_URL: z.string().url(),
  REDIS_SESSION_TTL_S: z.coerce.number().int().positive().default(3600),

  // MongoDB (optional)
  MONGODB_URL: z.string().url().optional(),
  MONGODB_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // LRU
  LRU_TTL_MS: z.coerce.number().int().positive().default(300_000),
  LRU_MAX: z.coerce.number().int().positive().default(1000),

  // AES-GCM session encryption
  ENCRYPTION_KEY_ID: z.string().min(1),
  ENCRYPTION_KEY_V1: z.string().min(32),
  ENCRYPTION_KEY_V2: z.string().min(32).optional(),
  ENCRYPTION_KEY_V3: z.string().min(32).optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return parsed.data;
}
