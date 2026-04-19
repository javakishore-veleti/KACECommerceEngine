import { beforeEach, describe, expect, it } from 'vitest';

import { LruSessionLayer } from '~/dao/impl/session/lru.layer.js';

import { makeOfflineSession, makeOnlineSession } from '../../../../fixtures/sessions.js';

describe('LruSessionLayer', () => {
  let lru: LruSessionLayer;

  beforeEach(() => {
    lru = new LruSessionLayer({ maxEntries: 100, ttlMs: 60_000 });
  });

  it('storeSession → loadSession round-trips', async () => {
    const s = makeOfflineSession();
    expect(await lru.storeSession(s)).toBe(true);
    const loaded = await lru.loadSession(s.id);
    expect(loaded?.accessToken).toBe(s.accessToken);
  });

  it('deleteSession removes the entry', async () => {
    const s = makeOfflineSession();
    await lru.storeSession(s);
    await lru.deleteSession(s.id);
    expect(await lru.loadSession(s.id)).toBeUndefined();
  });

  it('deleteSessions removes multiple entries', async () => {
    const s1 = makeOfflineSession({ id: 'offline_a.myshopify.com', shop: 'a.myshopify.com' });
    const s2 = makeOfflineSession({ id: 'offline_b.myshopify.com', shop: 'b.myshopify.com' });
    await lru.storeSession(s1);
    await lru.storeSession(s2);
    await lru.deleteSessions([s1.id, s2.id]);
    expect(await lru.loadSession(s1.id)).toBeUndefined();
    expect(await lru.loadSession(s2.id)).toBeUndefined();
  });

  it('findSessionsByShop returns all sessions (online + offline) for a shop', async () => {
    const shop = 'promptkart-dev.myshopify.com';
    const off = makeOfflineSession({ shop });
    const on = makeOnlineSession({ shop });
    await lru.storeSession(off);
    await lru.storeSession(on);
    const found = await lru.findSessionsByShop(shop);
    const ids = found.map((s) => s.id).sort();
    expect(ids).toEqual([off.id, on.id].sort());
  });

  it('respects TTL eviction', async () => {
    const quick = new LruSessionLayer({ maxEntries: 10, ttlMs: 10 });
    const s = makeOfflineSession();
    await quick.storeSession(s);
    await new Promise((r) => setTimeout(r, 30));
    expect(await quick.loadSession(s.id)).toBeUndefined();
  });

  it('respects capacity eviction', async () => {
    const small = new LruSessionLayer({ maxEntries: 2, ttlMs: 60_000 });
    await small.storeSession(makeOfflineSession({ id: 'a', shop: 'a' }));
    await small.storeSession(makeOfflineSession({ id: 'b', shop: 'b' }));
    await small.storeSession(makeOfflineSession({ id: 'c', shop: 'c' }));
    // 'a' should have been evicted
    expect(await small.loadSession('a')).toBeUndefined();
    expect(await small.loadSession('b')).toBeDefined();
    expect(await small.loadSession('c')).toBeDefined();
  });
});
