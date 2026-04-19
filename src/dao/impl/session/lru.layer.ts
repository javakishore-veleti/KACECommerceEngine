import { LRUCache } from 'lru-cache';

import type { Session } from '~/core/domain/Session.js';
import type { SessionDao } from '~/dao/session.dao.js';

/**
 * In-process LRU cache layer — hottest path. Bounded capacity + short TTL.
 *
 * Scope: single process. Reboots / deploys blow it away. This is intentional — upper layers
 * (Redis + Postgres) are durable; the LRU is just for low-latency reads in the same process.
 *
 * Stores sessions WITH plaintext access tokens. (Encryption at rest only matters for Redis + Postgres.)
 * Never serialize this map to disk.
 */
export class LruSessionLayer implements SessionDao {
  private readonly cache: LRUCache<string, Session>;

  /** Secondary index: shop → set of session ids (for `findSessionsByShop`). */
  private readonly byShop: Map<string, Set<string>>;

  constructor(params: { maxEntries: number; ttlMs: number }) {
    this.cache = new LRUCache<string, Session>({
      max: params.maxEntries,
      ttl: params.ttlMs,
      dispose: (_value, key) => {
        // When an entry expires from the main cache, evict from the shop index too.
        this.removeFromShopIndex(_value.shop, key);
      },
    });
    this.byShop = new Map();
  }

  async storeSession(session: Session): Promise<boolean> {
    this.cache.set(session.id, session);
    this.addToShopIndex(session.shop, session.id);
    return true;
  }

  async loadSession(id: string): Promise<Session | undefined> {
    return this.cache.get(id);
  }

  async deleteSession(id: string): Promise<boolean> {
    const existing = this.cache.get(id);
    if (existing) this.removeFromShopIndex(existing.shop, id);
    this.cache.delete(id);
    return true;
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    for (const id of ids) {
      const existing = this.cache.get(id);
      if (existing) this.removeFromShopIndex(existing.shop, id);
      this.cache.delete(id);
    }
    return true;
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    const ids = this.byShop.get(shop);
    if (!ids) return [];
    const out: Session[] = [];
    for (const id of ids) {
      const s = this.cache.get(id);
      if (s) out.push(s);
    }
    return out;
  }

  /** For readiness checks / diagnostics. */
  size(): number {
    return this.cache.size;
  }

  private addToShopIndex(shop: string, id: string): void {
    let set = this.byShop.get(shop);
    if (!set) {
      set = new Set();
      this.byShop.set(shop, set);
    }
    set.add(id);
  }

  private removeFromShopIndex(shop: string, id: string): void {
    const set = this.byShop.get(shop);
    if (!set) return;
    set.delete(id);
    if (set.size === 0) this.byShop.delete(shop);
  }
}
