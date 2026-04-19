import pino, { type Logger, type LoggerOptions } from 'pino';

import type { Env } from '~/config/env.js';

/**
 * Shared pino options. Used by Fastify (via `buildFastifyLoggerOptions`) and by any
 * non-HTTP code path that needs a logger (workers, CLIs, tests).
 */
function baseOptions(env: Env): LoggerOptions {
  const opts: LoggerOptions = {
    level: env.LOG_LEVEL,
    base: { service: 'kace-commerce-engine' },
    redact: {
      // Never log decrypted access tokens, encryption keys, or Authorization headers.
      paths: [
        'req.headers.authorization',
        'accessToken',
        'access_token_ct',
        'encryptionKey',
        'ENCRYPTION_KEY_V1',
        'ENCRYPTION_KEY_V2',
        'ENCRYPTION_KEY_V3',
      ],
      censor: '[REDACTED]',
    },
  };
  if (env.NODE_ENV === 'development') {
    opts.transport = {
      target: 'pino-pretty',
      options: { singleLine: false, colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
    };
  }
  return opts;
}

/** Standalone pino logger for non-HTTP contexts. */
export function createLogger(env: Env): Logger {
  return pino(baseOptions(env));
}

/**
 * Fastify's `logger` option accepts a LoggerOptions object — Fastify will build its own
 * pino instance internally. We pass options (not an instance) to stay compatible with
 * Fastify's logger type machinery.
 */
export function buildFastifyLoggerOptions(env: Env): LoggerOptions {
  return baseOptions(env);
}
