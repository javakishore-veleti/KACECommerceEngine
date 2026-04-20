import type { FastifyInstance } from 'fastify';

import type { ShopifyInstallService } from '~/service/shopify-install.service.js';

/**
 * Shopify OAuth install routes.
 *
 *   GET /auth?shop=<shop>.myshopify.com  — starts OAuth (Shopify library redirects to Shopify)
 *   GET /auth/callback                   — completes OAuth (Shopify library validates + exchanges)
 *
 * The Dev Dashboard app for KACE-PromptKart must be configured with:
 *   App URL:        <SHOPIFY_APP_URL>
 *   Redirect URL:   <SHOPIFY_APP_URL>/auth/callback
 */
export async function registerShopifyOAuthRoutes(
  app: FastifyInstance,
  installService: ShopifyInstallService,
): Promise<void> {
  app.get<{ Querystring: { shop?: string } }>('/auth', async (req, reply) => {
    const shop = req.query.shop;
    if (!shop) {
      return reply.code(400).send({ error: 'Missing ?shop=<shop>.myshopify.com' });
    }
    // `auth.begin` writes the redirect to the raw response and ends it.
    await installService.begin(req.raw, reply.raw, shop);
    return reply; // response already sent by shopify-api
  });

  app.get('/auth/callback', async (req, reply) => {
    try {
      const result = await installService.callback(req.raw, reply.raw);
      // shopify-api may have already written to the response during callback (it sets cookies etc).
      // We send a small success page ONLY if the raw response is still writable.
      if (!reply.raw.writableEnded) {
        return reply.type('text/html').send(successHtml(result.shop, result.sessionId));
      }
      return reply;
    } catch (err) {
      req.log.error({ err }, 'OAuth callback failed');
      if (!reply.raw.writableEnded) {
        return reply.code(500).type('text/html').send(errorHtml(err));
      }
      return reply;
    }
  });
}

function successHtml(shop: string, sessionId: string): string {
  return `<!doctype html><meta charset="utf-8">
  <title>KACE install complete</title>
  <style>body{font-family:system-ui;padding:40px;max-width:640px;margin:auto}
  code{background:#f2f2f2;padding:2px 6px;border-radius:4px}
  h1{color:#1f7a3a}</style>
  <h1>✓ Installed on ${escape(shop)}</h1>
  <p>Session persisted via KACE SessionDao (LRU → Redis → Postgres, AES-GCM at rest).</p>
  <p>Session id: <code>${escape(sessionId)}</code></p>
  <p>Check KACE's logs for the <code>storeSession</code> trace and Postgres for the encrypted row.</p>`;
}

function errorHtml(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `<!doctype html><meta charset="utf-8">
  <title>KACE install failed</title>
  <style>body{font-family:system-ui;padding:40px;max-width:640px;margin:auto}
  pre{background:#fee;padding:12px;border-radius:4px;overflow:auto}</style>
  <h1>× Install failed</h1>
  <pre>${escape(msg)}</pre>`;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
