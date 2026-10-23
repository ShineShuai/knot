// Long-lived device identity: an Ed25519 key pair kept in IndexedDB as a
// non-extractable CryptoKey. The peer id is a short hash of the public key.
import { toB64u, sha256 } from '../util/bytes.js';

const ALG = 'Ed25519';

export async function peerIdOf(pub) {
  return toB64u((await sha256(pub)).subarray(0, 8)); // 11 chars
}

export class Identity {
  constructor(privateKey, pub, id) {
    this.privateKey = privateKey;
    this.pub = pub;
    this.id = id;
  }
  async sign(data) {
    return new Uint8Array(await crypto.subtle.sign(ALG, this.privateKey, data));
  }
}

/** Load the stored identity or create one. `kv` is a store from store/kv.js. */
export async function loadIdentity(kv) {
  let pair = await kv.get('identity');
  if (!pair) {
    try {
      pair = await crypto.subtle.generateKey(ALG, false, ['sign', 'verify']);
    } catch {
      throw new Error('This browser lacks Ed25519 in WebCrypto. Please update it.');
    }
    await kv.put('identity', pair);
  }
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return new Identity(pair.privateKey, pub, await peerIdOf(pub));
}

const verifyKeys = new Map();

export async function verifySignature(pub, sig, data) {
  try {
    const cacheKey = toB64u(pub);
    if (!verifyKeys.has(cacheKey)) {
      verifyKeys.set(cacheKey, await crypto.subtle.importKey('raw', pub, ALG, false, ['verify']));
    }
    return await crypto.subtle.verify(ALG, verifyKeys.get(cacheKey), sig, data);
  } catch {
    return false;
  }
}
