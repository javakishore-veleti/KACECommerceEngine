import type { Session } from '~/core/domain/Session.js';

/**
 * KACE's SessionDao interface.
 *
 * Deliberately shaped to mirror Shopify's `@shopify/shopify-app-session-storage` `SessionStorage`
 * interface (same 5 methods) so the facade can be adapted for Shopify-library consumption if needed.
 * Our concrete impl additionally supports tenant-scoped session ids (KACE-internal sessions).
 *
 * Implementations:
 *   - dao/impl/session/lru.layer.ts       — in-process LRU (hot)
 *   - dao/impl/session/redis.layer.ts     — Redis (warm, cross-instance)
 *   - dao/impl/session/postgres.layer.ts  — Postgres (source of truth)
 *   - dao/impl/session/session.dao.impl.ts — facade composing the 3 layers
 */
export interface SessionDao {
  /** Persist a session. Must encrypt `accessToken` before write. Returns true on success. */
  storeSession(session: Session): Promise<boolean>;

  /** Load a session by id. Returns undefined if not found. Caller sees decrypted `accessToken`. */
  loadSession(id: string): Promise<Session | undefined>;

  /** Delete a single session by id. Returns true on success. */
  deleteSession(id: string): Promise<boolean>;

  /** Batch delete. Returns true on success. */
  deleteSessions(ids: string[]): Promise<boolean>;

  /** Find all sessions for a given shop — spans both online + offline session ids. */
  findSessionsByShop(shop: string): Promise<Session[]>;
}
