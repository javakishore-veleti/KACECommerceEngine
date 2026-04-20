# KACECommerceEngine

**The business-logic middleware for the KACE suite of Shopify storefronts.**

---

## What does KACE mean?

**KACE** is the umbrella brand for this 4-repo project. It is a standalone acronym
(treat it like IKEA or NASA — don't re-expand it in every sentence). Historically
the letters came from **K**ishore **A**pps **C**ommerce **E**ngine, but today KACE
is the name of a 4-service suite built on Shopify by
[**Kishore Veleti**](https://github.com/javakishore-veleti) — Shopify Partner org
*Kishore Applications* (Partner ID `4868609`, org id `214691442`).

**The 4 repos in the KACE suite:**

| Repo | Role |
| --- | --- |
| [**KACECommerceEngine**](https://github.com/javakishore-veleti/KACECommerceEngine) *(this repo)* | TypeScript + Fastify middleware — rule engine facade, rewards, Shopify BFF, hand-rolled SessionStorage. **The brain.** |
| [KACE-PromptKart](https://github.com/javakishore-veleti/KACE-PromptKart) | Hydrogen public storefront selling AI prompt packs (`promptkart-dev.myshopify.com`). |
| [KACE-StudyDesk](https://github.com/javakishore-veleti/KACE-StudyDesk) | Hydrogen public storefront selling micro-courses (`studydesk-dev.myshopify.com`). |
| [KACE-Extended-Rules-Sidecar](https://github.com/javakishore-veleti/KACE-Extended-Rules-Sidecar) | Spring Boot + Drools JVM sidecar invoked by this engine's multi-engine rule facade. |

---

## What is `KACECommerceEngine` specifically?

A TypeScript + Fastify microservice that sits **between** the Hydrogen storefronts
(customer-facing) and Shopify's Admin GraphQL (server-side). Every business decision
the storefronts need — "should this customer see the price?", "does this cart qualify
for a discount?", "grant reward points on this order?" — is answered here.

### Primary capabilities

1. **Multi-engine rule facade (consensus ranker, Mode A).** Evaluates the same rule
   set in parallel across multiple engines (`json-rules-engine`, `nools`, `rete-next`
   in-process + Drools via `KACE-Extended-Rules-Sidecar` over HTTP). A canonical-hash
   consensus ranker flags disagreements and returns the majority result.
2. **Rewards module.** Flagship consumer of the rule engine. Applies discounts, grants
   loyalty points, issues tags, sends notifications — all as rule-driven actions.
3. **Shopify MetaObjects as the authoring surface.** The merchant authors rule
   instances as `kace_reward_rule` MetaObjects in each dev store's admin; KACE reads
   them at runtime via Admin GraphQL. No custom admin UI needed in v0.
4. **Hand-rolled `SessionStorage`.** Full implementation of Shopify's 5-method
   interface as a 3-layer facade: **LRU → Redis → Postgres**, with AES-256-GCM at-rest
   encryption, key-versioning for rotation, single-flight cache-stampede protection,
   and a structured JSON lifecycle tracer.
5. **Shopify OAuth install handler.** `GET /auth` + `GET /auth/callback` routes that
   use `@shopify/shopify-api` to validate HMAC, exchange code for access token, and
   persist the real Shopify-library-produced Session via the SessionStorage above.

### Status

| What | State |
| --- | --- |
| SessionStorage facade (LRU + Redis + Postgres, AES-GCM, single-flight, tracer) | ✅ Built |
| Unit tests (AES-GCM cipher, LRU layer) — 13 passing | ✅ Green |
| Integration tests via `testcontainers` (real Postgres + Redis) — 9 passing | ✅ Green |
| Shopify OAuth install flow (real Shopify library → real `storeSession`) | ✅ Built |
| Multi-engine rule facade | ⏳ Not yet |
| Rewards module | ⏳ Not yet |
| Products BFF (Admin GraphQL proxy) | ⏳ Not yet |
| Webhook handlers | ⏳ Not yet |

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
| Logger | pino (JSON + pino-pretty in dev) |
| Config | zod-validated env loader |
| Tests | Vitest + `testcontainers` |
| Local infra | Docker Compose (Postgres + Redis + Mongo) |
| API port | 8080 |

---

## Directory layout (layered + workflow + tasks)

```
src/
├── api/                controllers + middleware + error advice
│   ├── controller/     shopify-oauth.controller.ts, health.controller.ts
│   └── middleware/     JWT validation, tenant router (future)
├── service/            interfaces at top; impls under impl/
│   ├── shopify-install.service.ts
│   └── impl/           orchestrates workflows per use case
│       └── shopify-install.service.impl.ts
├── tasks/              reusable tasks (shared across workflows)
├── core/               framework-free: no Fastify imports
│   ├── engine/         rule facade + factory + adapters + ranker (future)
│   ├── workflow/       Workflow + Task interfaces
│   ├── crypto/         AesGcmCipher + KeyProvider
│   └── domain/         Session, Rule, Action, Tenant types
├── dao/                data-access interfaces + impl/
│   ├── session.dao.ts
│   └── impl/session/   ★ 3-layer SessionStorage
│       ├── session.dao.impl.ts
│       ├── lru.layer.ts
│       ├── redis.layer.ts
│       ├── postgres.layer.ts
│       ├── lifecycle-tracer.ts
│       └── shopify-session-storage.adapter.ts
├── dtos/               request/ + response/
├── constants/, utils/
├── config/             env loader, Shopify API config
└── server.ts           Fastify bootstrap + manual DI wiring
```

Same layout is used in `KACE-Extended-Rules-Sidecar` (under `src/main/java/...`) so
the two backend services read as mirror images across languages.

---

## Local dev quick-start

```bash
# 1. Install (Node 20 LTS — use nvm)
nvm use 20
npm install

# 2. Local infra
docker compose up -d postgres redis

# 3. Env
cp .env.example .env
# Generate an AES key and paste as ENCRYPTION_KEY_V1
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# 4. Migrate
npm run migrate:up

# 5. Run tests
npx vitest run tests/unit          # unit tests
npx vitest run tests/integration   # integration w/ testcontainers

# 6. Run the server
npm run dev                        # Fastify :8080
```

---

## Running the real Shopify OAuth install (end-to-end validation)

See **[`docs/INSTALL_FLOW_SETUP.md`](docs/INSTALL_FLOW_SETUP.md)** — step-by-step:

1. Install `cloudflared` → start a tunnel exposing `:8080` as public HTTPS.
2. Configure the KACE-PromptKart Dev Dashboard app with the tunnel URL + `/auth/callback`.
3. Start KACE, click **Install app** in Dev Dashboard.
4. Watch your own tracer log print `storeSession` being called with a real
   Shopify-library-produced Session.
5. Verify in Postgres that the stored `access_token_ct` is ciphertext, not plaintext.

---

## License

MIT — see [`LICENSE`](LICENSE).

---

## Related planning docs (not in this repo)

Detailed design lives in the parent planning folder (`Shopify_Middleware/`):

- `README_KACECommerceEngine.md` — full architecture of this service
- `README_KACE-PromptKart.md` / `README_KACE-StudyDesk.md` / `README_KACE-Extended-Rules-Sidecar.md`
- `README_Claude_Kishore_ChatLog.md` — design conversation history
- `Development_Plan.xlsx` — phase-by-phase roadmap
- `diagrams/` — architecture + mindmap images
