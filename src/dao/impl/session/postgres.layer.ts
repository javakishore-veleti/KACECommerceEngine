import type { Pool } from 'pg';

import type { Session } from '~/core/domain/Session.js';
import type { SessionDao } from '~/dao/session.dao.js';

/**
 * Postgres source-of-truth layer.
 *
 * Schema (see migrations/1713528000000_sessions.js):
 *   sessions(id, tenant, shop, state, is_online, scope, expires,
 *            access_token_ct, encryption_key_id, online_access_info,
 *            created_at, updated_at)
 *
 * Like `RedisSessionLayer`, this layer is encryption-unaware — it stores whatever the
 * facade gives it, which means `access_token_ct` must already be a ciphertext envelope
 * from `AesGcmCipher.encrypt()`.
 */
export class PostgresSessionLayer implements SessionDao {
  constructor(private readonly pool: Pool) {}

  async storeSession(s: Session): Promise<boolean> {
    // Upsert. Idempotent — concurrent writes settle on the latest row.
    const sql = `
      INSERT INTO sessions
        (id, tenant, shop, state, is_online, scope, expires,
         access_token_ct, encryption_key_id, online_access_info,
         created_at, updated_at)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), now())
      ON CONFLICT (id) DO UPDATE SET
        tenant             = EXCLUDED.tenant,
        shop               = EXCLUDED.shop,
        state              = EXCLUDED.state,
        is_online          = EXCLUDED.is_online,
        scope              = EXCLUDED.scope,
        expires            = EXCLUDED.expires,
        access_token_ct    = EXCLUDED.access_token_ct,
        encryption_key_id  = EXCLUDED.encryption_key_id,
        online_access_info = EXCLUDED.online_access_info,
        updated_at         = now()
    `;
    const values = [
      s.id,
      s.tenant,
      s.shop,
      s.state ?? null,
      s.isOnline,
      s.scope ?? null,
      s.expires ?? null,
      s.accessToken ?? null, // facade passes the ciphertext here
      s.encryptionKeyId ?? null,
      s.onlineAccessInfo ? JSON.stringify(s.onlineAccessInfo) : null,
    ];
    await this.pool.query(sql, values);
    return true;
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM sessions WHERE id = $1 LIMIT 1', [id]);
    const row = rows[0];
    if (!row) return undefined;
    return rowToSession(row);
  }

  async deleteSession(id: string): Promise<boolean> {
    await this.pool.query('DELETE FROM sessions WHERE id = $1', [id]);
    return true;
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    if (ids.length === 0) return true;
    await this.pool.query('DELETE FROM sessions WHERE id = ANY($1::text[])', [ids]);
    return true;
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    const { rows } = await this.pool.query('SELECT * FROM sessions WHERE shop = $1', [shop]);
    return rows.map(rowToSession);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToSession(row: Record<string, any>): Session {
  return {
    id: row.id,
    tenant: row.tenant,
    shop: row.shop,
    state: row.state ?? undefined,
    isOnline: row.is_online,
    scope: row.scope ?? undefined,
    expires: row.expires ?? undefined,
    accessToken: row.access_token_ct ?? undefined, // facade will decrypt
    encryptionKeyId: row.encryption_key_id ?? undefined,
    onlineAccessInfo: row.online_access_info ?? undefined,
    createdAt: row.created_at ?? undefined,
    updatedAt: row.updated_at ?? undefined,
  };
}
