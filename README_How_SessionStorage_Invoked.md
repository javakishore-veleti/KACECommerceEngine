# How SessionStorage Is Invoked (in Production)

This document describes the **real runtime invocation paths** of `SessionDao` / the Shopify `SessionStorage` interface inside `KACECommerceEngine`. It is not about tests, not a conceptual explanation — it is what an on-call engineer needs to know about who calls what, when, and why.

---

## Placeholders

| Placeholder | Meaning |
| --- | --- |
| `<SHOP>` | A `.myshopify.com` handle, e.g. `<PROMPTKART_STORE>.myshopify.com` |
| `<SESSION_ID>` | Shopify session id — `offline_<SHOP>` for offline, `<SHOP>_<userId>` for online |
| `<TUNNEL_URL>` | Public HTTPS URL that reaches `localhost:8080` in dev (cloudflared / ngrok) |

---

## Summary of the 5 interface methods

| Method | What calls it (runtime) |
| --- | --- |
| `storeSession(session)`      | (1) OAuth install callback, (2) online-session refresh, (3) scope/token upgrade |
| `loadSession(id)`            | (4) every Admin GraphQL request where KACE needs a Session, (5) the `@shopify/shopify-api` library whenever it constructs a GraphQL client |
| `deleteSession(id)`          | (6) `app/uninstalled` webhook, (7) explicit 401 handling on a revoked token |
| `deleteSessions(ids)`        | (8) `shop/redact` GDPR webhook, (9) admin-driven bulk cleanup |
| `findSessionsByShop(shop)`   | (10) `shop/redact` preamble, (11) multi-user admin listings (future) |

All 5 are wired through the same `SessionDao` facade (LRU → Redis → Postgres, AES-GCM at rest). The adapter at `src/dao/impl/session/shopify-session-storage.adapter.ts` is what lets Shopify's libraries call them.

---

## Scenario 1 — Merchant installs the app (first-time session creation)

**Trigger.** Merchant clicks **Install** in the Shopify admin / Dev Dashboard for the `KACECommerceEngine`-backed custom app.

**Call sequence.**

```
Browser: GET /auth?shop=<SHOP>
  └─ api/controller/shopify-oauth.controller.ts handler
     └─ service/impl/shopify-install.service.impl.ts: begin()
        └─ @shopify/shopify-api auth.begin()
           └─ 302 redirect to Shopify's authorize endpoint

[ Merchant authenticates with Shopify, confirms scopes ]

Browser: GET /auth/callback?code=...&hmac=...&shop=...&state=...
  └─ api/controller/shopify-oauth.controller.ts handler
     └─ service/impl/shopify-install.service.impl.ts: callback()
        └─ @shopify/shopify-api auth.callback()
           │  validates HMAC
           │  exchanges `code` for an Admin API access token
           │  returns a library-produced Session { id, shop, accessToken, scope, ... }
           ▼
     └─ sessionStorage.storeSession(session)
        └─ ShopifySessionStorageAdapter.storeSession()
           └─ SessionDao.storeSession()  ← 3-layer write-through:
              1. cipher.encrypt(accessToken)   ← AES-GCM with current keyId
              2. PostgresSessionLayer.storeSession  (source of truth)
              3. RedisSessionLayer.storeSession    (warm cache, TTL)
              4. LruSessionLayer.storeSession      (in-proc, plaintext token for fast next-read)
```

**What lands in storage.**

- **Postgres (`sessions` table).** Row with `access_token_ct = 'v1:<base64>'` (ciphertext envelope carrying the keyId), `shop`, `scope`, `is_online=false`, `tenant`, timestamps.
- **Redis.** `kace:session:<SESSION_ID>` → JSON blob with encrypted `accessToken`; TTL = `REDIS_SESSION_TTL_S`. Shop secondary index `kace:shop:<SHOP>:sessions` gets the id SADD'd.
- **LRU.** In-memory entry with plaintext accessToken (fast local re-reads in the same process).

**What you see in logs.**

```
INFO  shopify.auth.callback — validating HMAC + exchanging code
INFO  sessionId=offline_<SHOP> shop=<SHOP> isOnline=false scope=...
      SESSION FROM SHOPIFY LIBRARY — handing off to SessionStorage.storeSession()
DEBUG dao=session method=storeSession sessionId=... shop=... isOnline=false
      layerHit=write-through durationMs=<N> ok=true session-dao-call
INFO  storeSession completed — 3-layer facade + AES-GCM at rest
```

**Failure modes.**

| Failure | Behaviour |
| --- | --- |
| Postgres write fails | The facade propagates the error. No Redis or LRU write happens. The OAuth callback handler returns 500. Merchant retries the install. |
| Redis write fails | Logged and swallowed (non-SoT). Postgres + LRU have the data. Next `loadSession` misses Redis, falls through to Postgres, and re-warms Redis. |
| LRU write fails | Effectively impossible (in-memory) but would be logged. |
| HMAC validation fails | `@shopify/shopify-api` throws before we ever reach `storeSession`. We never persist a bad session. |

**Idempotency.** `storeSession` upserts in Postgres (`ON CONFLICT DO UPDATE`). Re-running the OAuth flow with the same id is safe and refreshes the row.

---

## Scenario 2 — Every subsequent Admin GraphQL request (the hottest path)

**Trigger.** A KACE workflow needs Shopify Admin data — e.g., `EvaluateRulesWorkflow` needs the customer's purchase count, or `ApplyRewardsWorkflow` needs to tag the customer.

**Call sequence.**

```
workflow task (e.g. EnrichContextFromShopifyTask)
  └─ needs an Admin GraphQL client for <SHOP>
     └─ sessionStorage.loadSession(offline_<SHOP>)
        └─ ShopifySessionStorageAdapter.loadSession()
           └─ SessionDao.loadSession()
              ├─ LruSessionLayer.loadSession()
              │    └─ hit → return immediately (plaintext accessToken ready)
              ├─ miss → RedisSessionLayer.loadSession()
              │    └─ hit → ciphertext payload → cipher.decrypt → populate LRU → return
              └─ miss → PostgresSessionLayer.loadSession()
                   └─ hit → ciphertext payload → cipher.decrypt
                        → populate Redis + LRU → return
```

**Single-flight dedup.** Concurrent `loadSession(id)` misses for the same id are deduplicated: only one Postgres query fires even with 50 parallel callers. See `src/dao/impl/session/session.dao.impl.ts` — the `inFlightLoads` map.

**What you see in logs.**

LRU hit (fast path, < 1 ms):
```
DEBUG dao=session method=loadSession sessionId=offline_<SHOP> layerHit=lru ok=true
```

Postgres fallthrough (cold start, ~10-30 ms):
```
DEBUG dao=session method=loadSession sessionId=offline_<SHOP> layerHit=postgres durationMs=18 ok=true
```

**Failure modes.**

| Failure | Behaviour |
| --- | --- |
| Redis down | Read falls through to Postgres; logged. Perf degrades but correctness is fine. |
| Postgres down | `loadSession` throws. Caller should catch, treat as "session not found", and trigger re-auth path (redirect to `/auth`). |
| Session expired (online sessions) | `expires < now()` — Shopify library will discard; caller must re-authenticate. KACE doesn't auto-purge expired rows; reap via a background job (future). |
| Row exists but decryption fails | Most likely cause: legacy ciphertext encrypted with a keyId no longer known to the KeyProvider (bad key rotation). **Fail loud** — do not silently return `undefined`; log the keyId and surface an ops alert. |

**SLO target.** `loadSession` P99 < 20 ms (dominated by Redis) and P50 < 1 ms (LRU hit rate > 95 %).

---

## Scenario 3 — The `@shopify/shopify-api` library calls `loadSession` for us

The Shopify library doesn't just take a `SessionStorage` parameter — it **actively calls it** whenever it constructs an Admin GraphQL client from a session id.

```ts
// Typical KACE-side code that triggers a library-driven loadSession:
const client = new shopify.clients.Graphql({ session });
// ^^ internally, the library calls sessionStorage.loadSession(session.id)
//    to refresh the accessToken + scope before every call.
```

This means `loadSession` is not only called by *our* code — it's called by **the Shopify library itself** whenever KACE wants to talk to Shopify Admin. Perf + correctness of `SessionDao` directly shape Shopify API call latency + reliability.

---

## Scenario 4 — Merchant uninstalls the app

**Trigger.** Shopify POSTs the `app/uninstalled` webhook to `<TUNNEL_URL>/webhooks/app/uninstalled`.

**Call sequence.**

```
Shopify → POST /webhooks/app/uninstalled  (HMAC-signed)
  └─ webhooks/app-uninstalled.handler.ts
     ├─ verify HMAC using shopify.webhooks.hmacSecret
     └─ sessionStorage.deleteSession('offline_' + <SHOP>)
        └─ SessionDao.deleteSession()  ← fan-out delete:
           1. PostgresSessionLayer.deleteSession  (SoT first)
           2. RedisSessionLayer.deleteSession    (swallowed if fails)
           3. LruSessionLayer.deleteSession      (in-proc)
```

**What disappears from storage.**

- Postgres row gone.
- Redis key gone. Shop secondary-index entry SREM'd.
- LRU entry evicted.

**Failure modes.**

- **Webhook never arrives** (Shopify couldn't reach our endpoint). We're stuck with a stale session. Shopify retries for several days; if persistent, run a cleanup job that scans for sessions whose shop no longer exists in Admin API.
- **Postgres delete fails.** Webhook handler returns 500; Shopify retries. Idempotent delete, safe to retry.
- **Redis delete fails.** Logged, swallowed — the row is gone from SoT.

**Idempotency.** `DELETE ... WHERE id = $1` is idempotent. Repeated webhook deliveries (Shopify can duplicate) are safe.

---

## Scenario 5 — GDPR `shop/redact` webhook

**Trigger.** Shopify POSTs `shop/redact` (merchant requested 48-hour-later data deletion).

**Call sequence.**

```
Shopify → POST /webhooks/shop/redact  (HMAC-signed)
  └─ webhooks/shop-redact.handler.ts
     ├─ verify HMAC
     ├─ const sessions = await sessionStorage.findSessionsByShop(<SHOP>)
     │     └─ SessionDao.findSessionsByShop()
     │        └─ PostgresSessionLayer: SELECT * FROM sessions WHERE shop = $1
     │        └─ decrypt each row's accessToken on the way out
     └─ await sessionStorage.deleteSessions(sessions.map(s => s.id))
        └─ SessionDao.deleteSessions()  ← batch fan-out:
           1. Postgres: DELETE ... WHERE id = ANY($1::text[])
           2. Redis pipeline: DEL all keys, SREM from shop index
           3. LRU: for each id, delete from map + shop index
```

Also purge the tenant-scoped reward / customer-context rows for the shop (separate DAO — out of scope for this doc).

**Observability.** Emit a GDPR audit log entry with `{ shop, sessionsDeleted, rewardEventsPurged, customerContextsPurged, at }`. Retain this audit log even as you delete the actual data.

---

## Scenario 6 — Shopify returns 401 on an Admin GraphQL call

**Trigger.** A workflow task calls Admin GraphQL with an accessToken that Shopify has revoked (e.g., merchant rotated app credentials or manually uninstalled and reinstalled).

**Call sequence.**

```
workflow task
  └─ graphqlClient.query(...)
     └─ Shopify returns 401
        └─ task catches 401 and calls:
           sessionStorage.deleteSession(<SESSION_ID>)  ← same fan-out delete as Scenario 4
           └─ then fails the workflow with a typed "session-revoked" error
```

The workflow's outer `ErrorHandlerAdvice` converts the typed error into a 401/403 on the API response so the storefront can redirect to `/auth` to re-install.

---

## Scenario 7 — Online session scope upgrade or refresh

**Trigger.** The app was installed with one set of scopes; a new version requests additional scopes. Shopify's library produces an upgraded Session object, and we need to persist it (overwriting the previous one).

**Call sequence.**

```
Merchant re-authorizes (triggered automatically by Shopify when scopes change)
  → /auth/callback fires again with new code
  → auth.callback() produces upgraded Session with same id + new scope
  → sessionStorage.storeSession(upgradedSession)
     └─ SessionDao.storeSession()  upserts the existing row — same id, fresh ciphertext (because the token changed), updated scope
```

Because the id is identical (`offline_<SHOP>`), Postgres `ON CONFLICT DO UPDATE` replaces the old row in place. LRU + Redis are re-populated with the upgraded session.

**Encryption-key rotation interacts here.** If a session was stored under `v1` and we've since rotated to `v2`, the `storeSession` call re-encrypts with `v2`; the old ciphertext and its `keyId=v1` are overwritten. Over time, all sessions naturally migrate to the current key.

---

## Scenario 8 — Encryption key rotation (ops runbook)

**Trigger.** Ops runs the 3-monthly key rotation: mint a new AES-256 key, add it as `ENCRYPTION_KEY_V{n+1}`, and set `ENCRYPTION_KEY_ID=v{n+1}`. Legacy keys stay in env for decryption of existing rows.

**What happens in SessionStorage.**

- **Existing rows are NOT rewritten** on rotation. They keep their `access_token_ct = 'v{n}:...'` envelope.
- On the next `loadSession` for each row, the cipher reads the envelope's `keyId`, looks up the legacy `v{n}` key, and decrypts successfully. The caller gets a normal plaintext back.
- If that caller then calls `storeSession` (for any reason — e.g., the library refreshing the row), the new write uses the current key `v{n+1}`, so the envelope is upgraded in place.

**Safety guarantees.**

- Rotation does not require a coordinated downtime window.
- Legacy rows remain readable as long as their keyId is retained in env/SecretsProvider.
- An env with only the current key (legacy keys dropped) will **fail loud** on a legacy row — never silently. Drop legacy keys only after an audit confirms no rows reference them (`SELECT DISTINCT encryption_key_id FROM sessions`).

---

## Scenario 9 — Background cleanup + garbage collection (future)

A scheduled job runs nightly to:

1. Delete sessions with `expires < now() - <safety margin>` (online sessions only).
2. Delete sessions for shops Shopify no longer recognizes (e.g., missed uninstall webhooks).
3. Re-encrypt any row whose `encryption_key_id` is about to be retired (read, re-write via `storeSession` which upgrades to current key).

Each step ultimately fans out to the same SessionDao methods above.

---

## Observability checklist

Every SessionStorage invocation must produce:

1. **Structured trace record** from `LifecycleTracer` — `{method, sessionId, shop, isOnline, layerHit, durationMs, ok}`.
2. **Layer-hit metric** for `loadSession`: which of `lru` / `redis` / `postgres` / `miss` served the call. Alert if Postgres hit rate for `loadSession` exceeds 10 % (cache miss storm).
3. **Duration metric** per method, P50 / P95 / P99.
4. **Error rate** for each layer independently. Redis errors should not alert the SessionStorage team; they should alert the Redis team.

---

## Anti-patterns to avoid

- ❌ **Never log the decrypted accessToken.** The pino logger is configured to redact `accessToken` and `access_token_ct` fields; don't add new log lines that leak them.
- ❌ **Never call `loadSession` and then pass the session object to another service over the network without re-scoping.** The plaintext accessToken must stay within KACE's process memory.
- ❌ **Never skip the SessionStorage layer and read from Postgres directly for sessions.** You bypass the LRU + Redis + decryption + tracer. If you think you need to, build the thing you actually need on top of `SessionDao`.
- ❌ **Never call `storeSession` from a controller.** Go through a workflow task so the tracer + error handling are consistent.

---

## Where this code lives

| Piece | File |
| --- | --- |
| Interface | `src/dao/session.dao.ts` |
| Facade (3-layer + encryption + single-flight + tracer) | `src/dao/impl/session/session.dao.impl.ts` |
| LRU / Redis / Postgres layers | `src/dao/impl/session/{lru,redis,postgres}.layer.ts` |
| Lifecycle tracer | `src/dao/impl/session/lifecycle-tracer.ts` |
| Shopify adapter (the shim for the library) | `src/dao/impl/session/shopify-session-storage.adapter.ts` |
| OAuth install controller + service | `src/api/controller/shopify-oauth.controller.ts` + `src/service/impl/shopify-install.service.impl.ts` |
| AES-GCM cipher + key provider | `src/core/crypto/{AesGcmCipher,KeyProvider}.ts` |
| Postgres sessions migration | `migrations/*_sessions.js` |
| DI wiring | `src/server.ts` |

---

## Running the install flow to observe all of this live

See **[`docs/INSTALL_FLOW_SETUP.md`](docs/INSTALL_FLOW_SETUP.md)** for end-to-end steps: tunnel, Dev Dashboard app config, env, run, click Install, watch the tracer.
