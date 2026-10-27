// Sealed box to an X25519 public key: ephemeral ECDH -> HKDF -> AES-GCM.
// Output: ephemeral public key (32) || iv (12) || ciphertext. Only the holder of the
// matching private key can open it; who sent it is proven separately (a signature).
import { concat, randomBytes, utf8 } from '../util/bytes.js';

const ALG = { name: 'X25519' };

export async function newBoxKey() {
  const pair = await crypto.subtle.generateKey(ALG, false, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, pub };
}

async function sharedKey(privateKey, peerPub) {
  const pub = await crypto.subtle.importKey('raw', peerPub, ALG, false, []);
  const bits = await crypto.subtle.deriveBits({ ...ALG, public: pub }, privateKey, 256);
  const base = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const params = {
    name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8.encode('knot/box'),
  };
  return crypto.subtle.deriveKey(
    params, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

/** `aad` binds the box to its context; opening with a different one fails. */
export async function sealBox(recipientPub, plain, aad) {
  const ephemeral = await newBoxKey();
  const key = await sharedKey(ephemeral.privateKey, recipientPub);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plain);
  return concat(ephemeral.pub, iv, new Uint8Array(ct));
}

export async function openBox(privateKey, sealed, aad) {
  if (sealed.length < 32 + 12 + 16) throw new Error('Box is too short');
  const key = await sharedKey(privateKey, sealed.subarray(0, 32));
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: sealed.subarray(32, 44), additionalData: aad }, key, sealed.subarray(44),
  );
  return new Uint8Array(plain);
}
