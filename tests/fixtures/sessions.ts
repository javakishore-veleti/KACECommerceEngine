import type { Session } from '~/core/domain/Session.js';

export function makeOfflineSession(overrides: Partial<Session> = {}): Session {
  return {
    id: `offline_${overrides.shop ?? 'promptkart-dev.myshopify.com'}`,
    tenant: 'PROMPTKART',
    shop: 'promptkart-dev.myshopify.com',
    isOnline: false,
    scope: 'read_products,write_products',
    accessToken: 'shpat_test_ABC123',
    ...overrides,
  };
}

export function makeOnlineSession(overrides: Partial<Session> = {}): Session {
  return {
    id: `${overrides.shop ?? 'promptkart-dev.myshopify.com'}_12345`,
    tenant: 'PROMPTKART',
    shop: 'promptkart-dev.myshopify.com',
    isOnline: true,
    scope: 'read_products',
    accessToken: 'shpat_online_XYZ789',
    expires: new Date(Date.now() + 60_000),
    onlineAccessInfo: {
      expiresIn: 60,
      associatedUserScope: 'read_products',
      associatedUser: {
        id: 12345,
        firstName: 'Kishore',
        lastName: 'Veleti',
        email: 'kishore@example.com',
        emailVerified: true,
        accountOwner: true,
        locale: 'en',
        collaborator: false,
      },
    },
    ...overrides,
  };
}
