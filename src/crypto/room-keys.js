// A room is defined by a 128-bit secret that only travels in links and pairing
// codes. Two independent values are derived from it with HKDF:
//   id  - public topic name on signaling brokers (reveals nothing about the secret)
//   aes - AES-GCM key sealing everything that passes through brokers
import { concat, randomBytes, toB64u, utf8 } from '../util/bytes.js';

export const newRoomSecret = () => randomBytes(16);

export async function deriveRoomKeys(secret) {
  const base = await crypto.subtle.importKey(
    'raw',
    secret,
    'HKDF',
    false,
    ['deriveBits', 'deriveKey'],
  );
  const params = (info) => (
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8.encode(info) }
  );
  const idBits = await crypto.subtle.deriveBits(params('knot/room-id'), base, 96);
  const aes = await crypto.subtle.deriveKey(
    params('knot/room-key'), base, {
      name: 'AES-GCM',
      length: 256,
    }, false, ['encrypt', 'decrypt']);
  return { id: toB64u(new Uint8Array(idBits)), aes };
}

/** Encrypt; `aad` binds the ciphertext to its context (e.g. the topic). Output: iv || ciphertext.
 * */
export async function seal(key, plain, aad) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plain);
  return concat(iv, new Uint8Array(ct));
}

/** Inverse of seal(); throws if the key, data or aad do not match. */
export async function open(key, sealed, aad) {
  const plain = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: sealed.subarray(0, 12),
      additionalData: aad,
    }, key, sealed.subarray(12));
  return new Uint8Array(plain);
}
