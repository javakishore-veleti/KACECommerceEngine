# Running the Real Shopify OAuth Install Flow

This walks you through triggering `storeSession()` on the hand-rolled `SessionDaoFacade`
via a real Shopify OAuth install against `promptkart-dev`.

Total time: ~20 min of setup, then ~30 seconds to actually install and watch logs.

---

## Prereqs (already done)

- Docker Desktop running
- Node 20 installed
- `KACECommerceEngine` scaffolded with SessionStorage + OAuth wiring
- Dev store `promptkart-dev.myshopify.com` live

---

## 1. Install cloudflared (one-time)

```bash
brew install cloudflared
cloudflared --version   # expect >= 2024.x
```

Cloudflared gives you a free public HTTPS URL that proxies to `localhost:8080`. Shopify
needs an https URL it can reach — you can't give it `http://localhost:8080`.

---

## 2. Start a tunnel (one-time per dev session)

Open a **new Terminal tab** and leave it running:

```bash
cloudflared tunnel --url http://localhost:8080
```

After a few seconds you'll see output like:

```
2026-04-19T22:00:00Z INF +--------------------------------------------------------------------------------------------+
2026-04-19T22:00:00Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):   |
2026-04-19T22:00:00Z INF |  https://loose-oxygen-whale-7b3e.trycloudflare.com                                           |
2026-04-19T22:00:00Z INF +--------------------------------------------------------------------------------------------+
```

**Copy that HTTPS URL.** You'll paste it into `.env` and into Dev Dashboard.

> Note: a new URL is generated each time you start cloudflared. For a real demo,
> you may want a named tunnel (persistent URL) — not needed for tomorrow.

---

## 3. Configure the Dev Dashboard app

Open: `https://dev.shopify.com/dashboard/214691442/apps` → click **KACE-PromptKart**.

### 3a. Update URLs

Create a new version (existing v1-initial has `http://example.com` which is wrong now):

1. Click **Versions** (left sidebar) → **Create version**.
2. Fill:
   - **App URL:** `https://loose-oxygen-whale-7b3e.trycloudflare.com` (your cloudflared URL)
   - **Embed app in Shopify admin:** ❌ unchecked
   - **Webhooks API version:** 2026-04 (default)
   - **Scopes:** `read_products,write_products,read_customers,read_orders,read_metaobjects,write_metaobjects,read_inventory`
   - **Use legacy install flow:** ✅ checked (gives us the simpler install redirect for a custom app)
   - **Redirect URLs:** `https://loose-oxygen-whale-7b3e.trycloudflare.com/auth/callback`
3. Click **Release version** → name: `v2-with-cloudflared-url` → **Release**.

### 3b. Find your Client ID + Client Secret

In the same app, go to **Settings** (or wherever Dev Dashboard shows credentials). Find:

- **Client ID** (public — can live in `.env` uncensored) — e.g. `a4b05d995384ae5dff0a2b491b19be30`
- **Client Secret** (private — treat like a password; never commit; never paste in chat)

Copy both into your password manager.

---

## 4. Configure .env for KACECommerceEngine

Edit `git_repos/KACECommerceEngine/.env` (copy from `.env.example` if not present):

```bash
# Server
NODE_ENV=development
PORT=8080
LOG_LEVEL=debug

# Postgres / Redis
DATABASE_URL=postgres://kace:kace@localhost:5432/kace_dev
REDIS_URL=redis://localhost:6379/0

# LRU
LRU_TTL_MS=300000
LRU_MAX=1000

# AES-GCM (generate a 32-byte base64 key once for v0)
ENCRYPTION_KEY_ID=v1
ENCRYPTION_KEY_V1=PASTE_HERE_BASE64_32_BYTES

# Shopify — the real credentials
SHOPIFY_API_KEY=a4b05d995384ae5dff0a2b491b19be30
SHOPIFY_API_SECRET=PASTE_CLIENT_SECRET_FROM_DEV_DASHBOARD
SHOPIFY_APP_URL=https://loose-oxygen-whale-7b3e.trycloudflare.com
SHOPIFY_SCOPES=read_products,write_products,read_customers,read_orders,read_metaobjects,write_metaobjects,read_inventory
SHOPIFY_API_VERSION=2026-01
SHOPIFY_DEFAULT_TENANT=PROMPTKART
```

### Generate a base64 AES-256 key

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Paste the output as `ENCRYPTION_KEY_V1`.

---

## 5. Start the databases + run migrations

```bash
cd git_repos/KACECommerceEngine
docker compose up -d postgres redis
npm run migrate:up     # creates the sessions table
```

---

## 6. Start KACE

```bash
npm run dev
```

You should see:

```
INFO  KACECommerceEngine listening. OAuth begin at GET /auth?shop=<shop>.myshopify.com
```

Leave this running.

---

## 7. Trigger the install from Dev Dashboard

Option A — via Dev Dashboard Overview page (simplest):
1. Go to: `https://dev.shopify.com/dashboard/214691442/apps/349555458049`
2. Click **Install app** (top-right).
3. Pick `promptkart-dev` → confirm scopes → **Install**.

Option B — via direct URL (skips the Dev Dashboard UI):
1. In your browser, paste:
   `https://<your-cloudflared>.trycloudflare.com/auth?shop=promptkart-dev.myshopify.com`
2. It redirects to Shopify → log in as merchant → confirm scopes → **Install**.
3. Shopify redirects back to `/auth/callback`.

---

## 8. Watch it happen (the payoff)

In the KACE terminal window you'll see something like:

```
INFO  shopify.auth.callback — validating HMAC + exchanging code
INFO  sessionId=offline_promptkart-dev.myshopify.com shop=promptkart-dev.myshopify.com
      isOnline=false scope=read_products,write_products,...
      SESSION FROM SHOPIFY LIBRARY — handing off to SessionStorage.storeSession()
DEBUG dao=session method=storeSession sessionId=offline_... shop=... isOnline=false
      layerHit=write-through durationMs=XX ok=true session-dao-call
INFO  storeSession completed — 3-layer facade + AES-GCM at rest
```

That's the moment. A **real Shopify-library-produced Session** hit your hand-rolled
`SessionDaoFacade`, got AES-GCM-encrypted, and persisted through LRU → Redis → Postgres.

Your browser lands on the KACE success page showing the session id.

---

## 9. Verify in Postgres + Redis

```bash
# Postgres: you should see one row with access_token_ct = 'v1:<base64>' (ciphertext, NOT plaintext)
psql postgres://kace:kace@localhost:5432/kace_dev \
  -c "SELECT id, tenant, shop, is_online, left(access_token_ct, 30) AS ct_prefix, encryption_key_id FROM sessions;"

# Redis: you should see a key kace:session:offline_promptkart-dev.myshopify.com
docker exec -it kace-redis redis-cli
127.0.0.1:6379> KEYS kace:session:*
127.0.0.1:6379> GET kace:session:offline_promptkart-dev.myshopify.com
```

If both commands show data and NEITHER contains the plaintext access token, your
SessionStorage is provably working against real Shopify input.

---

## 10. Uninstall (clean up)

To re-run the install (e.g. after rotating the encryption key):

In Shopify admin for promptkart-dev: Apps → KACE-PromptKart → **Delete / Uninstall**.
Then repeat step 7.

Or drop the session row directly:
```bash
psql postgres://kace:kace@localhost:5432/kace_dev -c "TRUNCATE sessions;"
docker exec kace-redis redis-cli FLUSHDB
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| OAuth callback errors with "HMAC validation failed" | Client Secret in `.env` doesn't match Dev Dashboard. Re-copy. |
| Browser times out hitting the trycloudflare URL | Cloudflared tunnel died. Restart it. |
| KACE crashes at startup: zod env error | Missing env var. Read the error — it names the missing field. |
| "Shopify redirects to localhost:8080" instead of cloudflared URL | You forgot to update the App URL in Dev Dashboard. Redo step 3a. |
| `storeSession` never logs | The callback is failing before reaching it. Check the Fastify log for the actual error. |
| Redis key exists but Postgres row missing | Postgres write failed — check pool connection. |
