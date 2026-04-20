import type { SessionStorage } from '@shopify/shopify-app-session-storage';
import type { Session as ShopifySession } from '@shopify/shopify-api';
import { Session } from '@shopify/shopify-api';

import type { Session as KaceSession } from '~/core/domain/Session.js';
import type { SessionDao } from '~/dao/session.dao.js';

/**
 * Adapter: exposes our SessionDaoFacade via the @shopify/shopify-app-session-storage
 * `SessionStorage` interface that Shopify's libraries + framework wrappers expect.
 *
 * When Shopify's OAuth install flow completes and our controller calls
 * `sessionStorage.storeSession(shopifySession)`, the call lands here, gets mapped
 * onto our domain Session, and runs through the 3-layer facade (LRU -> Redis -> Postgres)
 * with AES-GCM encryption at rest.
 *
 * Tenant scoping: defaults to env.SHOPIFY_DEFAULT_TENANT (single-tenant v0). When we
 * add StudyDesk we'll resolve tenant from shop domain.
 */
export class ShopifySessionStorageAdapter implements SessionStorage {
  constructor(
    private readonly sessionDao: SessionDao,
    private readonly defaultTenant: string,
  ) {}

  async storeSession(session: ShopifySession): Promise<boolean> {
    return this.sessionDao.storeSession(this.toKace(session));
  }

  async loadSession(id: string): Promise<ShopifySession | undefined> {
    const s = await this.sessionDao.loadSession(id);
    return s ? this.toShopify(s) : undefined;
  }

  async deleteSession(id: string): Promise<boolean> {
    return this.sessionDao.deleteSession(id);
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    return this.sessionDao.deleteSessions(ids);
  }

  async findSessionsByShop(shop: string): Promise<ShopifySession[]> {
    const list = await this.sessionDao.findSessionsByShop(shop);
    return list.map((s) => this.toShopify(s));
  }

  // ------------------- mappers -------------------
  private toKace(s: ShopifySession): KaceSession {
    return {
      id: s.id,
      tenant: this.defaultTenant as KaceSession['tenant'],
      shop: s.shop,
      state: s.state,
      isOnline: s.isOnline,
      scope: s.scope,
      expires: s.expires ?? undefined,
      accessToken: s.accessToken,
      onlineAccessInfo: s.onlineAccessInfo as KaceSession['onlineAccessInfo'],
    };
  }

  private toShopify(s: KaceSession): ShopifySession {
    const out = new Session({
      id: s.id,
      shop: s.shop,
      state: s.state ?? '',
      isOnline: s.isOnline,
      accessToken: s.accessToken,
      scope: s.scope,
      expires: s.expires,
    });
    if (s.onlineAccessInfo) {
      // @shopify/shopify-api's Session stores onlineAccessInfo on the instance; assign directly
      (out as unknown as { onlineAccessInfo: unknown }).onlineAccessInfo = s.onlineAccessInfo;
    }
    return out;
  }
}
