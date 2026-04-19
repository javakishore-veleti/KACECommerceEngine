/**
 * KeyProvider — supplies AES-GCM keys indexed by keyId. Supports key-versioning:
 *   - `current` → the keyId used for NEW encryption operations
 *   - `get(keyId)` → returns the key material for any known version (for decryption of legacy ciphertexts)
 *
 * In production this is backed by SecretsProvider (AWS Secrets Manager + Azure Key Vault).
 * In v0 local dev it's backed directly by env vars. The abstraction keeps the cipher layer
 * agnostic of where keys come from.
 */
export interface KeyProvider {
  /** The current keyId — every new encryption uses this. */
  current(): string;
  /** Resolve key bytes (32 raw bytes, AES-256) for a given keyId. Throws if unknown. */
  get(keyId: string): Uint8Array;
  /** List all known keyIds (for diagnostic / health-check purposes). */
  knownIds(): string[];
}

/**
 * Env-backed KeyProvider for v0 local dev. Accepts base64-encoded 32-byte keys.
 */
export class EnvKeyProvider implements KeyProvider {
  private readonly keys: Map<string, Uint8Array>;
  private readonly currentId: string;

  constructor(params: { currentId: string; keys: Record<string, string> }) {
    this.keys = new Map();
    for (const [id, b64] of Object.entries(params.keys)) {
      const raw = decodeBase64(b64);
      if (raw.byteLength !== 32) {
        throw new Error(
          `KeyProvider: key '${id}' must be 32 raw bytes (AES-256); got ${raw.byteLength}`,
        );
      }
      this.keys.set(id, raw);
    }
    if (!this.keys.has(params.currentId)) {
      throw new Error(
        `KeyProvider: current keyId '${params.currentId}' is not in the provided keys`,
      );
    }
    this.currentId = params.currentId;
  }

  current(): string {
    return this.currentId;
  }

  get(keyId: string): Uint8Array {
    const k = this.keys.get(keyId);
    if (!k) throw new Error(`KeyProvider: unknown keyId '${keyId}'`);
    return k;
  }

  knownIds(): string[] {
    return [...this.keys.keys()];
  }
}

function decodeBase64(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}
