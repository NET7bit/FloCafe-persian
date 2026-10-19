import { safeStorage } from 'electron';

/**
 * Versioned envelope for a secret persisted inside the SQLite settings table.
 *
 * Format: `flosec1:<base64(safeStorage.encryptString(value))>`
 *
 * Scope (owner decision, SEC-02): only `cloud_api_key` is wrapped by this
 * helper. `cloud_device_secret` and `jwt_secret` keep their current storage
 * until a separate approved change.
 *
 * Rules enforced here:
 * - `flosec1:` is only ever produced after a successful `safeStorage`
 *   encryption; callers must never persist raw plaintext of a wrapped secret.
 * - Decryption failures return `null`; ciphertext is never re-exposed.
 * - When secure storage is not genuinely available (missing backend or the
 *   `basic_text` fallback), encryption is refused so callers fail closed
 *   instead of silently writing plaintext.
 */

const ENVELOPE_PREFIX = 'flosec1:';

/** True when the value is already a `flosec1` envelope. */
export function isEncryptedSettingValue(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(ENVELOPE_PREFIX);
}

/**
 * Whether OS-backed encryption is genuinely usable. Mirrors the check used by
 * the Google Drive token store: an unavailable backend or the `basic_text`
 * plaintext fallback counts as unavailable.
 */
export function isSecureStorageAvailable(): boolean {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    const backend = typeof safeStorage.getSelectedStorageBackend === 'function'
      ? safeStorage.getSelectedStorageBackend()
      : null;
    return !backend || !['basic_text', ''].includes(backend);
  } catch {
    return false;
  }
}

/**
 * Encrypts a non-empty plaintext secret into a `flosec1` envelope.
 * Throws when secure storage is unavailable or encryption fails; callers must
 * treat a throw as "cannot persist this secret" and fail closed.
 */
export function encryptSecret(plaintext: string): string {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('Cannot encrypt an empty secret');
  }
  if (!isSecureStorageAvailable()) {
    throw new Error('Secure storage is not available');
  }
  return ENVELOPE_PREFIX + safeStorage.encryptString(plaintext).toString('base64');
}

/**
 * Decrypts a `flosec1` envelope. Returns null for any failure — malformed
 * base64, decrypt error, empty result, non-envelope input — so a corrupt or
 * foreign value can never reach the network, UI or logs as ciphertext.
 */
export function decryptSecret(value: string): string | null {
  try {
    if (!isEncryptedSettingValue(value)) return null;
    const payload = value.slice(ENVELOPE_PREFIX.length);
    if (payload.length === 0) return null;
    const decrypted = safeStorage.decryptString(Buffer.from(payload, 'base64'));
    return typeof decrypted === 'string' && decrypted.length > 0 ? decrypted : null;
  } catch {
    return null;
  }
}

/**
 * Display suffix for a masked secret. Envelopes are decrypted first so the
 * visible `****last4` always belongs to the real secret, never to ciphertext.
 * An unreadable envelope masks as empty (distinguishable, secret-free).
 */
export function maskedSecretSuffix(value: string): string {
  const displayValue = isEncryptedSettingValue(value) ? (decryptSecret(value) ?? '') : value;
  return displayValue ? `****${displayValue.slice(-4)}` : '';
}
