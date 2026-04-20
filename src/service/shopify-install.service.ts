import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Orchestrates the Shopify OAuth install flow.
 *
 * Two entry points matching the two HTTP routes:
 *   - begin:     GET /auth?shop=<shop>  → 302 to Shopify
 *   - callback:  GET /auth/callback?code=...&hmac=...  → exchange, persist via SessionStorage, respond
 */
export interface ShopifyInstallService {
  begin(rawRequest: IncomingMessage, rawResponse: ServerResponse, shop: string): Promise<void>;
  callback(rawRequest: IncomingMessage, rawResponse: ServerResponse): Promise<{ shop: string; sessionId: string }>;
}
