/**
 * Tenant identities. Every KACE record is scoped by tenant — same human customer on both
 * storefronts produces two separate records in KACE.
 */
export const Tenants = {
  PROMPTKART: 'PROMPTKART',
  STUDYDESK: 'STUDYDESK',
  /**
   * Reserved for KACE-internal sessions (admin-token caching, metaobject snapshots,
   * customer-context derivations, idempotency keys).
   */
  KACE_INTERNAL: 'KACE_INTERNAL',
} as const;

export type Tenant = (typeof Tenants)[keyof typeof Tenants];

export function isTenant(v: unknown): v is Tenant {
  return typeof v === 'string' && v in Tenants;
}
