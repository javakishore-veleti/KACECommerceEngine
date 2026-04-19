import type { Tenant } from './Tenant.js';

/**
 * KACE Session — the domain object persisted through the SessionStorage facade.
 *
 * Shape follows Shopify's @shopify/shopify-api `Session` closely (so we can adapt
 * to/from the library's interface cheaply) but adds KACE-specific fields:
 *   - tenant          : which KACE tenant this session belongs to
 *   - encryptionKeyId : which AES-GCM key was used to encrypt accessToken (key-versioning)
 *
 * The accessToken field lives in-memory in plaintext ONLY while this Session
 * is being actively handled. Persistence layers must encrypt before write and
 * decrypt on read.
 */
export interface Session {
  /**
   * Session identifier. Two canonical shapes:
   *  - `offline_{shop}`        for long-lived offline sessions
   *  - `{shop}_{userId}`       for short-lived online sessions bound to a specific user
   * KACE-internal sessions may use arbitrary prefixes (e.g. `admintoken:PROMPTKART`, `metaobjects:STUDYDESK:kace_reward_rule`).
   */
  id: string;

  tenant: Tenant;

  /** The `*.myshopify.com` domain this session is associated with. */
  shop: string;

  /** OAuth state nonce (legacy install flow). */
  state?: string;

  /** True = online session (user-bound, short-lived); false = offline (app-bound, long-lived). */
  isOnline: boolean;

  /** Shopify access scope string (comma-separated). */
  scope?: string;

  /** Online-session expiry (undefined for offline sessions). */
  expires?: Date;

  /** Plaintext Shopify Admin API access token. Persistence layers MUST encrypt before write. */
  accessToken?: string;

  /** Id of the AES-GCM key used to encrypt `accessToken` at rest. */
  encryptionKeyId?: string;

  /** Online-session-only: user-info payload returned by Shopify at OAuth exchange. */
  onlineAccessInfo?: {
    expiresIn: number;
    associatedUserScope: string;
    associatedUser: {
      id: number;
      firstName: string;
      lastName: string;
      email: string;
      emailVerified: boolean;
      accountOwner: boolean;
      locale: string;
      collaborator: boolean;
    };
  };

  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Helper to distinguish online vs offline sessions by id pattern.
 * Useful for `findSessionsByShop` disambiguation and GDPR `shop/redact` batch deletes.
 */
export function isOfflineSessionId(id: string): boolean {
  return id.startsWith('offline_');
}

export function extractShopFromSessionId(id: string): string | null {
  if (id.startsWith('offline_')) return id.slice('offline_'.length);
  const underscore = id.indexOf('_');
  if (underscore <= 0) return null;
  return id.slice(0, underscore);
}
