// LEGACY-CURVES: the identity seed of a device without WebCrypto Ed25519, encrypted at rest.
// The AES-GCM key is a non-extractable CryptoKey. WebKit wraps stored CryptoKeys with a master
// key kept in the system Keychain, so a copy of the IndexedDB files (backup, forensic image)
// holds no usable seed. It is no defence against code running in this page: that can ask
// WebCrypto to decrypt (the CSP in index.html is what keeps foreign code out).
import { randomBytes } from '../util/bytes.js';

/** `seed` (32 bytes) -> { wrap: CryptoKey, iv, ct }, as stored in IndexedDB. */
export async function sealSeed(seed) {
  const wrap = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrap, seed));
  return { wrap, iv, ct };
}

export async function openSeed({ wrap, iv, ct }) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, wrap, ct));
}
