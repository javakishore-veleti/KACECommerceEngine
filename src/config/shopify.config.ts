import {
  ApiVersion,
  LATEST_API_VERSION,
  LogSeverity,
  shopifyApi,
} from '@shopify/shopify-api';
import '@shopify/shopify-api/adapters/node';

import type { Env } from './env.js';

/**
 * Build a configured @shopify/shopify-api instance.
 * Used by OAuth begin/callback handlers and by any Admin GraphQL client we construct later.
 */
export function createShopifyApi(env: Env) {
  const hostName = env.SHOPIFY_APP_URL.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const scopes = env.SHOPIFY_SCOPES.split(',').map((s) => s.trim()).filter(Boolean);

  return shopifyApi({
    apiKey: env.SHOPIFY_API_KEY,
    apiSecretKey: env.SHOPIFY_API_SECRET,
    apiVersion: (env.SHOPIFY_API_VERSION as ApiVersion) ?? LATEST_API_VERSION,
    scopes,
    hostName,
    hostScheme: 'https',
    isEmbeddedApp: false,
    logger: { level: LogSeverity.Info },
  });
}
