// Long-lived device identity: an Ed25519 key pair kept in IndexedDB as a non-extractable
// CryptoKey. Where WebCrypto lacks Ed25519 (iOS 16) it is a 32-byte seed signed with TweetNaCl:
// readable by any script of this origin, so weaker. The peer id is a hash of the public key.
import { concat, fromB64u, randomBytes, toB64u, sha256 } from '../util/bytes.js';
import { hasNative, softNacl, yieldToUi } from './curves.js';

const ALG = 'Ed25519';

export async function peerIdOf(pub) {
  return toB64u((await sha256(pub)).subarray(0, 8)); // 11 chars
}

export class Identity {
  /** `id` names this key (it is what links and the network know us by). `member`: who we speak
   *  as in rooms: ourselves, unless this is a linked device (`cert`: see delegation.js). */
  constructor(privateKey, pub, id) { // privateKey: CryptoKey, or the 64-byte NaCl key
    this.privateKey = privateKey;
    this.pub = pub;
    this.id = id;
    this.member = id;
    this.cert = null;
  }
  async sign(data) {
    if (this.privateKey instanceof Uint8Array) {
      return (await softNacl()).sign.detached(data, this.privateKey);
    }
    return new Uint8Array(await crypto.subtle.sign(ALG, this.privateKey, data));
  }
}

/** Load the stored identity or create one. `kv` is a store from store/kv.js. */
export async function loadIdentity(kv) {
  let pair = await kv.get('identity');
  if (pair?.seed) return identityFromSeed(pair.seed); // made where WebCrypto lacks Ed25519
  if (!pair) {
    if (!(await hasNative(ALG))) {
      const seed = randomBytes(32);
      await kv.put('identity', { seed });
      return identityFromSeed(seed);
    }
    pair = await crypto.subtle.generateKey(ALG, false, ['sign', 'verify']);
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
  if (!(await hasNative(ALG))) {
    const { secretKey } = (await softNacl()).sign.keyPair.fromSeed(seed);
    const pub = secretKey.slice(32);
    return new Identity(secretKey, pub, await peerIdOf(pub));
  }
  const der = concat(PKCS8_PREFIX, seed);
  const key = await crypto.subtle.importKey('pkcs8', der, ALG, true, ['sign']);
  const pub = fromB64u((await crypto.subtle.exportKey('jwk', key)).x);
  return new Identity(key, pub, await peerIdOf(pub));
}

const verifyKeys = new Map();
const L = (1n << 252n) + 27742317777372353535851937790883648493n; // order of the base point

/** As WebCrypto: S must be below L, or `sig` has a twin that verifies too. */
async function verifySoft(pub, sig, data) {
  if (sig.length !== 64) return false;
  let s = 0n;
  for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(sig[i]);
  if (s >= L) return false;
  const nacl = await softNacl();
  await yieldToUi(); // a batch of these must not freeze the page
  return nacl.sign.detached.verify(data, sig, pub);
}

export async function verifySignature(pub, sig, data) {
  try {
    if (!(await hasNative(ALG))) return await verifySoft(pub, sig, data);
    const cacheKey = toB64u(pub);
    if (!verifyKeys.has(cacheKey)) {
      verifyKeys.set(cacheKey, await crypto.subtle.importKey('raw', pub, ALG, false, ['verify']));
    }
    return await crypto.subtle.verify(ALG, verifyKeys.get(cacheKey), sig, data);
  } catch {
    return false;
  }
}
