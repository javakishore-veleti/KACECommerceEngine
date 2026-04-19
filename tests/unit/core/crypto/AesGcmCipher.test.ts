import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { AesGcmCipher } from '~/core/crypto/AesGcmCipher.js';
import { EnvKeyProvider } from '~/core/crypto/KeyProvider.js';

import { makeCipher } from '../../../fixtures/keys.js';

describe('AesGcmCipher', () => {
  it('round-trips plaintext', () => {
    const { cipher } = makeCipher();
    const ct = cipher.encrypt('hello, kace');
    expect(ct.startsWith('v1:')).toBe(true);
    expect(cipher.decrypt(ct)).toBe('hello, kace');
  });

  it('produces different ciphertexts for the same plaintext (random IVs)', () => {
    const { cipher } = makeCipher();
    const a = cipher.encrypt('same');
    const b = cipher.encrypt('same');
    expect(a).not.toBe(b);
    expect(cipher.decrypt(a)).toBe('same');
    expect(cipher.decrypt(b)).toBe('same');
  });

  it('rejects tampered ciphertext (authTag mismatch)', () => {
    const { cipher } = makeCipher();
    const ct = cipher.encrypt('secret');
    const parts = ct.split(':');
    const keyId = parts[0]!;
    const envelope = parts[1]!;
    const tampered = Buffer.from(envelope, 'base64');
    tampered[tampered.length - 1] = (tampered[tampered.length - 1]! ^ 0xff) & 0xff;
    const malformed = `${keyId}:${tampered.toString('base64')}`;
    expect(() => cipher.decrypt(malformed)).toThrow();
  });

  it('rejects ciphertext with missing keyId separator', () => {
    const { cipher } = makeCipher();
    expect(() => cipher.decrypt('no-separator-blob')).toThrow(/missing keyId/);
  });

  it('rejects ciphertext shorter than IV + authTag', () => {
    const { cipher } = makeCipher();
    const shortEnv = Buffer.alloc(10).toString('base64');
    expect(() => cipher.decrypt(`v1:${shortEnv}`)).toThrow(/too short/);
  });

  it('decrypts legacy ciphertext after key rotation', () => {
    // Fresh key material for v1 + v2.
    const v1KeyB64 = randomBytes(32).toString('base64');
    const v2KeyB64 = randomBytes(32).toString('base64');

    // Pass 1: v1 is current. Encrypt a token.
    const cipherV1 = new AesGcmCipher(
      new EnvKeyProvider({ currentId: 'v1', keys: { v1: v1KeyB64 } }),
    );
    const legacyCiphertext = cipherV1.encrypt('shpat_legacy_access_token');
    expect(legacyCiphertext.startsWith('v1:')).toBe(true);

    // Pass 2: we've rotated. v2 is current, v1 retained for legacy reads.
    const cipherAfterRotation = new AesGcmCipher(
      new EnvKeyProvider({ currentId: 'v2', keys: { v1: v1KeyB64, v2: v2KeyB64 } }),
    );
    expect(cipherAfterRotation.currentKeyId()).toBe('v2');
    expect(cipherAfterRotation.decrypt(legacyCiphertext)).toBe('shpat_legacy_access_token');

    // New encryptions use v2.
    const newCt = cipherAfterRotation.encrypt('shpat_fresh');
    expect(newCt.startsWith('v2:')).toBe(true);
  });

  it('fails loudly if the keyId in a ciphertext is unknown', () => {
    const { cipher } = makeCipher();
    const ct = cipher.encrypt('x');
    const envelope = ct.split(':')[1]!;
    expect(() => cipher.decrypt(`vUNKNOWN:${envelope}`)).toThrow(/unknown keyId/);
  });
});
