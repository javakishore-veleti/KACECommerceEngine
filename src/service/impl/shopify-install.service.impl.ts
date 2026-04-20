import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Shopify } from '@shopify/shopify-api';
import type { SessionStorage } from '@shopify/shopify-app-session-storage';
import type { Logger } from 'pino';

import type { ShopifyInstallService } from '~/service/shopify-install.service.js';

/**
 * Thin Shopify OAuth orchestrator.
 *
 * begin()    -> shopify.auth.begin()     redirects the browser to Shopify
 * callback() -> shopify.auth.callback()  validates HMAC, exchanges code for access token,
 *               returns a real Session, which we then persist via our SessionStorage adapter.
 *
 * The `sessionStorage.storeSession(session)` call on line ~N below is THE MOMENT where
 * Shopify's library-produced Session hits our hand-rolled SessionDao facade.
 */
export class ShopifyInstallServiceImpl implements ShopifyInstallService {
  constructor(
    private readonly shopify: Shopify,
    private readonly sessionStorage: SessionStorage,
    private readonly logger: Logger,
  ) {}

  async begin(rawRequest: IncomingMessage, rawResponse: ServerResponse, shop: string): Promise<void> {
    this.logger.info({ shop }, 'shopify.auth.begin');
    await this.shopify.auth.begin({
      shop: this.shopify.utils.sanitizeShop(shop, true)!,
      callbackPath: '/auth/callback',
      isOnline: false,
      rawRequest,
      rawResponse,
    });
  }

  async callback(rawRequest: IncomingMessage, rawResponse: ServerResponse): Promise<{ shop: string; sessionId: string }> {
    this.logger.info('shopify.auth.callback — validating HMAC + exchanging code');
    const { session } = await this.shopify.auth.callback({ rawRequest, rawResponse });

    this.logger.info(
      { sessionId: session.id, shop: session.shop, isOnline: session.isOnline, scope: session.scope },
      'SESSION FROM SHOPIFY LIBRARY — handing off to SessionStorage.storeSession()',
    );

    // THE MOMENT: library-produced Session -> our hand-rolled SessionDao facade.
    const ok = await this.sessionStorage.storeSession(session);
    if (!ok) throw new Error('SessionStorage.storeSession returned false');

    this.logger.info({ sessionId: session.id }, 'storeSession completed — 3-layer facade + AES-GCM at rest');
    return { shop: session.shop, sessionId: session.id };
  }
}
