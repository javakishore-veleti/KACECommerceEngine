import { randomBytes } from 'node:crypto';

import { EnvKeyProvider } from '~/core/crypto/KeyProvider.js';
import { AesGcmCipher } from '~/core/crypto/AesGcmCipher.js';

/**
 * Generate a fresh AesGcmCipher with random keys for each test suite.
 * Accepts additional legacy keyIds (for rotation / legacy-decrypt tests).
 */
export function makeCipher(options: { currentId: string; legacyIds?: string[] } = { currentId: 'v1' }): {
  cipher: AesGcmCipher;
  keyProvider: EnvKeyProvider;
} {
  const allIds = [options.currentId, ...(options.legacyIds ?? [])];
  const keys: Record<string, string> = {};
  for (const id of allIds) {
    keys[id] = randomBytes(32).toString('base64');
  }
  const keyProvider = new EnvKeyProvider({ currentId: options.currentId, keys });
  return { cipher: new AesGcmCipher(keyProvider), keyProvider };
}
