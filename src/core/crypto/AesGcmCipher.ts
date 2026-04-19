import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { KeyProvider } from './KeyProvider.js';

/**
 * AES-256-GCM authenticated encryption with key-versioning.
 *
 * Ciphertext envelope (base64-encoded on the wire, after the `v` prefix):
 *   keyId + ':' + base64(iv || ciphertext || authTag)
 *
 *   iv         : 12 bytes (96-bit nonce — GCM standard)
 *   ciphertext : plaintext bytes, length N
 *   authTag    : 16 bytes (128-bit GCM auth tag)
 *
 * Rationale:
 *  - Storing the keyId inline means the cipher can find the right key during decryption
 *    even after rotation (support for N legacy keys + 1 current key).
 *  - 96-bit IVs are GCM-spec-recommended; random IVs are safe at the volumes we'll see.
 *  - The auth tag is tacked on the end (Node's GCM API exposes it separately; we concatenate
 *    so the envelope is one self-contained blob).
 */
export class AesGcmCipher {
  private static readonly ALGO = 'aes-256-gcm';
  private static readonly IV_BYTES = 12;
  private static readonly TAG_BYTES = 16;

  constructor(private readonly keys: KeyProvider) {}

  encrypt(plaintext: string): string {
    const keyId = this.keys.current();
    const key = this.keys.get(keyId);
    const iv = randomBytes(AesGcmCipher.IV_BYTES);
    const cipher = createCipheriv(AesGcmCipher.ALGO, key, iv);
    const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
    const tag = cipher.getAuthTag();
    const envelope = Buffer.concat([iv, ct, tag]).toString('base64');
    return `${keyId}:${envelope}`;
  }

  decrypt(ciphertext: string): string {
    const sep = ciphertext.indexOf(':');
    if (sep <= 0) throw new Error('AesGcmCipher.decrypt: malformed ciphertext (missing keyId)');
    const keyId = ciphertext.slice(0, sep);
    const envelope = Buffer.from(ciphertext.slice(sep + 1), 'base64');
    if (envelope.byteLength <= AesGcmCipher.IV_BYTES + AesGcmCipher.TAG_BYTES) {
      throw new Error('AesGcmCipher.decrypt: malformed ciphertext (too short)');
    }
    const iv = envelope.subarray(0, AesGcmCipher.IV_BYTES);
    const tag = envelope.subarray(envelope.byteLength - AesGcmCipher.TAG_BYTES);
    const ct = envelope.subarray(AesGcmCipher.IV_BYTES, envelope.byteLength - AesGcmCipher.TAG_BYTES);
    const key = this.keys.get(keyId);
    const decipher = createDecipheriv(AesGcmCipher.ALGO, key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  }

  /** Expose the keyId that would be used for the next encrypt — useful for row bookkeeping. */
  currentKeyId(): string {
    return this.keys.current();
  }
}
