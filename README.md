# KACECommerceEngine

**TypeScript + Fastify middleware — the business-logic brain of the KACE suite.**

Multi-engine rule facade with Mode-A consensus ranker · Rewards module · Shopify Admin BFF · Hand-rolled Shopify `SessionStorage` as a 3-layer facade (LRU → Redis → Postgres) with AES-GCM encryption at rest.

---

## Placeholders used in this README

Substitute these variables with your own values when reading.

| Placeholder | Description | Example |
| --- | --- | --- |
| `<GITHUB_HANDLE>` | GitHub account the repos live under | `your-github-handle` |
| `<OWNER_NAME>` | Human-readable owner name | `Jane Doe` |
| `<ORG_NAME>` | Shopify Partner organization name | `<Your Applications>` |
| `<PARTNER_ID>` | Shopify Partner numeric id | `0000000` |
| `<ORG_ID>` | Shopify Dev Dashboard org id | `000000000` |
| `<PROMPTKART_STORE>` | PromptKart dev store handle | `promptkart-dev` |
| `<STUDYDESK_STORE>` | StudyDesk dev store handle | `studydesk-dev` |
| `<TUNNEL_URL>` | Public HTTPS URL tunneling to `localhost:8080` (cloudflared / ngrok) | `https://xxx.trycloudflare.com` |

---

## What does KACE mean?

**KACE** is the umbrella brand for this 4-repo project. Treat it as a standalone acronym (like IKEA or NASA) — don't re-expand it in every sentence. Historically the letters came from **K**ishore **A**pps **C**ommerce **E**ngine; today it's the suite's brand name.

**The 4 repos:**

| Repo | Role |
| --- | --- |
| [**KACECommerceEngine**](https://github.com/<GITHUB_HANDLE>/KACECommerceEngine) *(this repo)* | TS + Fastify middleware. Rule facade, rewards, Shopify BFF, hand-rolled SessionStorage. **The brain.** |
| [KACE-PromptKart](https://github.com/<GITHUB_HANDLE>/KACE-PromptKart) | Hydrogen public storefront — AI prompt packs on `<PROMPTKART_STORE>.myshopify.com`. |
| [KACE-StudyDesk](https://github.com/<GITHUB_HANDLE>/KACE-StudyDesk) | Hydrogen public storefront — micro-courses on `<STUDYDESK_STORE>.myshopify.com`. |
| [KACE-Extended-Rules-Sidecar](https://github.com/<GITHUB_HANDLE>/KACE-Extended-Rules-Sidecar) | Java + Spring Boot + Drools JVM sidecar called by this engine's rule facade. |

---

## Architecture

### Where this service sits

```
           Customer (browser)                     Customer (browser)
                  │                                        │
                  ▼                                        ▼
     ┌─────────────────────────────┐          ┌─────────────────────────────┐
     │  KACE-PromptKart            │          │  KACE-StudyDesk             │
     │  Hydrogen :3000 (storefront)│          │  Hydrogen :3001 (storefront)│
     └──────────────┬──────────────┘          └──────────────┬──────────────┘
                    │ Customer Account API JWT               │
                    │ POST /api/v1/rules/evaluate            │
                    │ POST /api/v1/rewards/apply             │
                    └───────────────┬────────────────────────┘
                                    ▼
                    ┌────────────────────────────────┐
                    │  KACECommerceEngine (this)     │
                    │  Fastify, TypeScript, :8080    │
                    │                                │
                    │  - Shopify OAuth install       │
                    │  - Multi-engine rule facade    │
                    │    (consensus ranker, Mode A)  │
                    │  - Rewards workflows           │
                    │  - Shopify Admin GraphQL BFF   │
                    │  - SessionStorage facade       │
                    │    (LRU → Redis → Postgres)    │
                    └──────┬─────────┬───────────────┘
                           │         │
             Admin GraphQL │         │ HTTP /evaluate/drools
                           ▼         ▼
                    ┌────────────┐  ┌────────────────────────────┐
                    │ Shopify    │  │ KACE-Extended-Rules-Sidecar│
                    │ Admin API  │  │ Spring Boot + Drools :8081 │
                    └────────────┘  └────────────────────────────┘
```

### Cross-cutting invariants

- **The only service that calls Shopify Admin GraphQL.** Storefronts never do — they delegate to this engine.
- **Tenant-scoped everything.** Every KACE-owned record has a `(tenant, customerId)` composite key. The same human buying on both storefronts produces two separate records. No cross-tenant leak.
- **Consensus ranker never blocks on any one engine.** Per-engine timeout budget; erroring engines are dropped from the consensus, logged, and the majority result is returned.
- **Framework-free core.** Nothing in `src/core/` imports Fastify or any web framework. Pure domain logic, pure rule-engine logic. Swappable.

---

## Subsystems

### 1. Hand-rolled SessionStorage (built)

A 3-layer facade implementing Shopify's 5-method `SessionStorage` interface.

> **How SessionStorage is actually invoked in production** — the runbook covering all 9 runtime invocation scenarios (install, per-request Admin GraphQL, uninstall, GDPR redact, 401 handling, scope upgrade, key rotation, background cleanup, and how the Shopify library itself drives `loadSession`) lives in **[`README_How_SessionStorage_Invoked.md`](README_How_SessionStorage_Invoked.md)**. Read that next if you want the on-call engineer's view.

```
storeSession(session)     write-through  Postgres (SoT) → Redis (warm) → LRU (hot)
                          accessToken AES-GCM encrypted before any persistence
loadSession(id)           read-through   LRU → Redis → Postgres
                          on lower-layer hit, upper layers are populated
                          single-flight dedup on concurrent misses
deleteSession(id)         fan-out delete  Postgres + Redis + LRU
deleteSessions([ids])     batch fan-out delete
findSessionsByShop(shop)  Postgres indexed query, rows decrypted on return
```

Non-obvious guarantees:

- **AES-256-GCM with key-versioning.** Each ciphertext envelope carries the `keyId` that encrypted it. Rotating keys (e.g. every 3 months) lets you keep N legacy keys for decryption while new writes use the current one. Legacy rows stay readable.
- **Cache-stampede protection.** On a `loadSession` miss, a single-flight map dedupes concurrent loads for the same id → 50 parallel callers produce exactly 1 Postgres query (proven in `tests/integration`).
- **Graceful degradation.** Redis or LRU failures are logged + swallowed on the read path; writes still succeed if Postgres (source of truth) succeeds. Postgres failure fails loud.
- **Lifecycle tracer.** Every interface call emits one structured JSON record: `{method, sessionId, shop, isOnline, layerHit, durationMs, ok, err}`.

**Test coverage:** 13 unit + 9 integration tests (via `testcontainers` with real Postgres 16 + Redis 7). All 22 green.

### 2. Shopify OAuth install flow (built)

End-to-end OAuth install wiring. When a merchant clicks **Install** in Dev Dashboard:

1. Browser lands at `GET /auth?shop=<store>.myshopify.com`.
2. `@shopify/shopify-api` writes a 302 redirect to Shopify.
3. Merchant authenticates + confirms scopes.
4. Shopify redirects back to `GET /auth/callback?code=…&hmac=…&shop=…&state=…`.
5. The library validates HMAC, exchanges `code` for an Admin API access token, produces a `Session` object.
6. We hand that Session to our `ShopifySessionStorageAdapter`, which maps it onto our domain `Session` and runs it through the SessionStorage facade above — AES-GCM-encrypted before it hits Redis or Postgres.
7. A success page is returned to the merchant's browser.

The `ShopifySessionStorageAdapter` implements `@shopify/shopify-app-session-storage`'s `SessionStorage` interface by delegating to our `SessionDao`. This is the shim that lets Shopify's libraries **call** our hand-rolled storage — the moment of "real library → real session → real DB row."

End-to-end setup + walkthrough: **[`docs/INSTALL_FLOW_SETUP.md`](docs/INSTALL_FLOW_SETUP.md)**.

### 3. Multi-engine rule facade (planned, v0.2)

```
        RuleEngineFacade.evaluate(rules, context)
                          │
          ┌──────┬────────┴────────┬──────────────────┐
          ▼      ▼                 ▼                  ▼
       json-  nools-            rete-next-      ExtendedRulesSidecar
       rules  adapter           adapter         adapter (HTTP)
                                                      │
                                      ┌───────────────┘
                                      ▼
                          ConsensusRanker (Mode A)
                    canonicalize each engine's actions
                    → sha256 hash per engine
                    → group by hash
                    → if 1 group: consensus = true
                    → else: return majority, log disagreements
                                      │
                                      ▼
                                actions[] + meta
```

Authored rules live as **Shopify MetaObjects** (type `kace_reward_rule`) inside each dev store's admin. `LoadActiveRulesTask` fetches the current snapshot via Admin GraphQL (cached ~5 min via SessionStorage) and the facade hands it to all enabled adapters concurrently.

**Why multi-engine:** agreeing results are trustworthy; **disagreeing** results are the interesting signal — they tell you a rule definition or translator has a bug. This is the portfolio story of the project.

### 4. Rewards module (planned)

Flagship consumer of the rule engine. Exposes:

```
POST /api/v1/rewards/apply      runs rules on cart.updated → discount/tag/notify actions
POST /api/v1/rewards/earn       runs rules on order.placed → grant points, badges
GET  /api/v1/rewards/balance    customer's current tenant-scoped reward balance
GET  /api/v1/rewards/history    customer's reward event log
```

Reward state (points, earned rewards, redeemed rewards) persists in Postgres keyed by `(tenant, customerId)`.

---

## Workflow + task architecture

Every business use case in `service/impl/` is expressed as a **Workflow** — a deterministic ordered composition of **Tasks**. Tasks share a single `WorkflowContext` passed through the chain.

```
Controller (api/)                  — thin route handler, HTTP only
     ↓
ServiceImpl (service/impl/)        — instantiates + runs a Workflow
     ↓
Workflow                           — ordered list of tasks
     ↓
Task 1 → Task 2 → … → Task N       — each reads + writes WorkflowContext
```

**Task location rule:**
- **Reusable** tasks live at top-level `src/tasks/`: `ValidateRequestTask`, `ResolveTenantTask`, `LoadActiveRulesTask`, `InvokeRuleEngineFacadeTask`, `BuildResponseTask`, etc.
- **Workflow-specific** tasks live *inside* the workflow's folder: `service/impl/workflows/<UseCase>Workflow/tasks/`.

The rule engine facade is invoked **only** via `InvokeRuleEngineFacadeTask` — never directly from a controller or service impl. This keeps the invocation surface consistent and easy to mock.

Workflow + Task interfaces live in `src/core/workflow/` so they're framework-free.

---

## Directory layout

```
src/
├── api/                        controllers + middleware + error advice
│   ├── controller/             shopify-oauth.controller.ts · health.controller.ts
│   ├── middleware/             JWT validation · tenant router (future)
│   └── advice/                 global exception handler (future)
│
├── service/                    service interfaces at top; impls under impl/
│   ├── shopify-install.service.ts
│   └── impl/
│       ├── shopify-install.service.impl.ts
│       └── workflows/
│           ├── Workflow.ts     framework-free (re-exported from core/)
│           └── <UseCase>Workflow/<UseCase>Workflow.ts + tasks/
│
├── tasks/                      reusable tasks (shared across workflows)
│   └── Task.ts                 (future — ValidateRequest, ResolveTenant, …)
│
├── core/                       framework-free: no Fastify imports
│   ├── engine/                 rule facade + factory + adapters + ranker (future)
│   ├── workflow/               Workflow, Task, WorkflowContext interfaces
│   ├── crypto/                 AesGcmCipher + KeyProvider
│   └── domain/                 Session, Rule, Action, Tenant
│
├── dao/                        data-access interfaces + impl/
│   ├── session.dao.ts
│   └── impl/session/           ★ 3-layer SessionStorage
│       ├── session.dao.impl.ts
│       ├── lru.layer.ts
│       ├── redis.layer.ts
│       ├── postgres.layer.ts
│       ├── lifecycle-tracer.ts
│       └── shopify-session-storage.adapter.ts
│
├── dtos/                       request/ + response/
├── constants/
├── utils/
├── config/                     env loader, Shopify API config, DI
├── observability/              pino logger, health, readiness
├── webhooks/                   Shopify webhook handlers (future)
└── server.ts                   Fastify bootstrap + manual DI wiring
```

Same layered layout as `KACE-Extended-Rules-Sidecar` (under `src/main/java/...`) so the two backend services read as mirror images across languages.

---

## Tech stack

| Layer | Choice |
| --- | --- |
| Language | TypeScript (strict) |
| Framework | Fastify 4 |
| Session SoT | Postgres 16 (via `pg`) |
| Session warm cache | Redis 7 (via `ioredis`) |
| Session hot cache | in-process `lru-cache` |
| Shopify auth | `@shopify/shopify-api` v11 + `@shopify/shopify-app-session-storage` |
| Encryption | AES-256-GCM via Node `crypto`, key-versioned |
| Logger | pino (JSON in prod + pino-pretty in dev) |
| Config | zod-validated env loader |
| Tests | Vitest + `testcontainers` (real Postgres + Redis in integration tests) |
| Local infra | Docker Compose (Postgres + Redis + Mongo) |
| API port | 8080 |

---

## Local dev quick-start

```bash
# 1. Node 20 LTS (the repo has a .nvmrc)
nvm use 20
npm install

# 2. Start local infra
docker compose up -d postgres redis

# 3. Env
cp .env.example .env
# Generate an AES-256 key and paste as ENCRYPTION_KEY_V1:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# 4. Apply the migration (creates the sessions table)
npm run migrate:up

# 5. Tests
npx vitest run tests/unit           # unit tests (no Docker needed for unit)
npx vitest run tests/integration    # integration w/ testcontainers (needs Docker)

# 6. Run the server
npm run dev                          # Fastify listens on :8080
```

---

## Running the real Shopify OAuth install (end-to-end)

Full walk-through in **[`docs/INSTALL_FLOW_SETUP.md`](docs/INSTALL_FLOW_SETUP.md)**. Short form:

1. `brew install cloudflared` → start a tunnel exposing `:8080` → note `<TUNNEL_URL>`.
2. In Dev Dashboard, create/update a custom-distribution app for `<PROMPTKART_STORE>` with App URL `<TUNNEL_URL>` and redirect URL `<TUNNEL_URL>/auth/callback`. Note the Client ID + Client Secret.
3. Populate `.env` with `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL=<TUNNEL_URL>`, and scopes.
4. Start KACE (`npm run dev`).
5. Click **Install app** in Dev Dashboard → pick `<PROMPTKART_STORE>` → authorize.
6. Watch the `storeSession` tracer fire in KACE's log output.
7. Verify in Postgres that `access_token_ct` is ciphertext (starts with `v1:`), not plaintext.

---

## License

MIT — see [`LICENSE`](LICENSE).

---

## Related planning docs

Detailed design docs (not in this repo) live alongside this project under the parent planning folder. They cover the full suite architecture, per-service READMEs, a conversation log, the development-plan spreadsheet, and diagrams (architecture + mindmap).
