// Long-lived device identity: an Ed25519 key pair kept in IndexedDB as a
// non-extractable CryptoKey. The peer id is a short hash of the public key.
import { concat, fromB64u, toB64u, sha256 } from '../util/bytes.js';

const ALG = 'Ed25519';

export async function peerIdOf(pub) {
  return toB64u((await sha256(pub)).subarray(0, 8)); // 11 chars
}

export class Identity {
  /** `id` names this key (it is what links and the network know us by). `member`: who we speak
   *  as in rooms: ourselves, unless this is a linked device (`cert`: see delegation.js). */
  constructor(privateKey, pub, id) {
    this.privateKey = privateKey;
    this.pub = pub;
    this.id = id;
    this.member = id;
    this.cert = null;
  }
  async sign(data) {
    return new Uint8Array(await crypto.subtle.sign(ALG, this.privateKey, data));
  }
}

/** Load the stored identity or create one. `kv` is a store from store/kv.js. */
export async function loadIdentity(kv) {
  let pair = await kv.get('identity');
  if (!pair) {
    const generate = () => crypto.subtle.generateKey(ALG, false, ['sign', 'verify']);
    try {
      pair = await generate();
    } catch {
      try { // seen once on a freshly started WebKit: the first call failed, the next worked
        await new Promise((resolve) => setTimeout(resolve, 100));
        pair = await generate();
      } catch (err) {
        throw new Error(`This browser lacks Ed25519 in WebCrypto. Please update it. (${err.name})`,
          { cause: err });
      }
    }
    await kv.put('identity', pair);
  }
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return new Identity(pair.privateKey, pub, await peerIdOf(pub));
}

const PKCS8_PREFIX = Uint8Array.from(
  [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20],
);

/** The identity a 32-byte seed stands for. Used for recovery codes: the same seed gives the
 *  same key on any device, so the code can be written down. */
export async function identityFromSeed(seed) {
  const der = concat(PKCS8_PREFIX, seed);
  const key = await crypto.subtle.importKey('pkcs8', der, ALG, true, ['sign']);
  const pub = fromB64u((await crypto.subtle.exportKey('jwk', key)).x);
  return new Identity(key, pub, await peerIdOf(pub));
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
