/* eslint-disable camelcase */
// Sessions table — source of truth for the 3-layer SessionStorage facade.
// Columns mirror the Shopify @shopify/shopify-api Session shape (online + offline)
// plus our own tenant + encryption-key-version bookkeeping.

exports.up = (pgm) => {
  pgm.createTable('sessions', {
    id:               { type: 'text',          primaryKey: true }, // 'offline_{shop}' | '{shop}_{userId}'
    tenant:           { type: 'text',          notNull: true },    // 'PROMPTKART' | 'STUDYDESK' | 'KACE_INTERNAL'
    shop:             { type: 'text',          notNull: true },    // e.g. 'promptkart-dev.myshopify.com'
    state:            { type: 'text',          notNull: false },   // OAuth state nonce (legacy)
    is_online:        { type: 'boolean',       notNull: true, default: false },
    scope:            { type: 'text',          notNull: false },   // Shopify scope string
    expires:          { type: 'timestamptz',   notNull: false },   // online session expiry
    // Encrypted payload — AES-GCM ciphertext+nonce+tag bundle (base64). We NEVER store the raw access token.
    access_token_ct:  { type: 'text',          notNull: false },
    encryption_key_id:{ type: 'text',          notNull: false },   // e.g. 'v1', 'v2'
    // Optional online-session-only fields (stored as JSON for simplicity):
    online_access_info: { type: 'jsonb',       notNull: false },
    // Bookkeeping
    created_at:       { type: 'timestamptz',   notNull: true, default: pgm.func('now()') },
    updated_at:       { type: 'timestamptz',   notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('sessions', 'shop');
  pgm.createIndex('sessions', ['tenant', 'shop']);
  pgm.createIndex('sessions', ['tenant', 'is_online']);
};

exports.down = (pgm) => {
  pgm.dropTable('sessions');
};
