// The recovery code: how an identity comes back after the original device lost its key.
//
// While the original device works, it makes a recovery key from a random seed and signs a recovery
// certificate for it (crypto/delegation.js). The seed, that certificate and, if there is one,
// the secret of the room where the person's devices find each other (the "channel") go into a
// code, encrypted with a passphrase (AES-GCM under a PBKDF2 key, as the backup file is).
// The device does not keep the code. On any device, the code and the passphrase give the
// recovery key back; it signs a certificate for that device's own key, which then speaks for
// the old identity like any linked device. The main key itself never leaves its device.
//
// Whoever has the code and the passphrase can act as the person, so both stay offline, apart.
import { MIN_PASSPHRASE, ITERATIONS, backupSecret } from '../store/backup.js';
import {
  concat, fromB64u, fromUtf8, randomBytes, toB64u, utf8,
} from '../util/bytes.js';
import { makeChainCert, makeRecoveryCert, verifyRecoveryCert } from './delegation.js';
import { identityFromSeed, peerIdOf } from './identity.js';

export const CODE_PREFIX = 'knot-ik1-';
const VERSION = 1;
const [SALT, IV, TAG] = [16, 12, 16];
const HEAD = 1 + 4 + SALT; // version, iterations (u32), salt
const B64U = /^[A-Za-z0-9_-]+$/;
const isB64u = (s, length) => typeof s === 'string' && s.length === length && B64U.test(s);

/** `code`: not_a_code | wrong_passphrase | damaged | newer | empty_passphrase |
 *  short_passphrase | owns_rooms (i18n `recoveryErr_<code>`). */
export class RecoveryError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RecoveryError';
    this.code = code;
  }
}

/** Original device: a code for `main` (an Identity). `channel`: the secret of the devices' channel
 *  (base64url) or null. Resolves to { code, q: the recovery public key, ms }. */
export async function makeRecoveryCode(
  main, passphrase, { channel = null, iterations = ITERATIONS, now = Date.now() } = {},
) {
  if (typeof passphrase !== 'string' || !passphrase) throw new RecoveryError('empty_passphrase');
  if (passphrase.length < MIN_PASSPHRASE) throw new RecoveryError('short_passphrase');
  if (channel !== null && !isB64u(channel, 22)) throw new RecoveryError('damaged');
  const seed = randomBytes(32);
  const rc = await makeRecoveryCert(main, (await identityFromSeed(seed)).pub, now);
  const { key, salt } = await backupSecret(passphrase, { iterations });
  const head = concat(Uint8Array.of(VERSION, iterations >>> 24, iterations >>> 16, iterations >>> 8,
    iterations), salt);
  const iv = randomBytes(IV);
  const plain = utf8.encode(JSON.stringify({
    s: toB64u(seed), r: rc.r, ms: rc.ms, sig: rc.sig, ch: channel,
  }));
  const body = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: head }, key, plain,
  );
  return { code: CODE_PREFIX + toB64u(concat(head, iv, new Uint8Array(body))), q: rc.q, ms: now };
}

/** Read a code (the code in a text; spaces and line breaks inside it are ignored). Resolves to
 *  { recovery: the recovery key as an Identity, rc: its certificate, channel, member: the id of
 *  the identity it brings back }. */
export async function readRecoveryCode(input, passphrase) {
  const squeezed = String(input ?? '').replace(/\s+/g, '');
  const found = [...squeezed.matchAll(/knot-ik1-([A-Za-z0-9_-]+)/g)].pop();
  if (!found) throw new RecoveryError('not_a_code');
  let bytes;
  try { bytes = fromB64u(found[1]); } catch { throw new RecoveryError('not_a_code'); }
  if (bytes.length < HEAD + IV + TAG) throw new RecoveryError('not_a_code');
  if (bytes[0] > VERSION) throw new RecoveryError('newer');
  if (bytes[0] !== VERSION) throw new RecoveryError('not_a_code');
  if (typeof passphrase !== 'string' || !passphrase) throw new RecoveryError('empty_passphrase');
  const iterations = ((bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4]) >>> 0;
  let secret;
  try {
    secret = await backupSecret(passphrase, { salt: bytes.slice(5, HEAD), iterations });
  } catch { throw new RecoveryError('damaged'); } // a crafted number of rounds
  let plain;
  try {
    plain = await crypto.subtle.decrypt({
      name: 'AES-GCM', iv: bytes.subarray(HEAD, HEAD + IV), additionalData: bytes.subarray(0, HEAD),
    }, secret.key, bytes.subarray(HEAD + IV));
  } catch { throw new RecoveryError('wrong_passphrase'); }
  let m;
  try { m = JSON.parse(fromUtf8(new Uint8Array(plain))); } catch {
    throw new RecoveryError('damaged');
  }
  if (!m || !isB64u(m.s, 43) || !isB64u(m.r, 43) || !isB64u(m.sig, 86)
    || !Number.isSafeInteger(m.ms) || (m.ch !== null && !isB64u(m.ch, 22))) {
    throw new RecoveryError('damaged');
  }
  const recovery = await identityFromSeed(fromB64u(m.s));
  const rc = { r: m.r, q: toB64u(recovery.pub), ms: m.ms, sig: m.sig };
  if (!(await verifyRecoveryCert(rc))) throw new RecoveryError('damaged');
  return { recovery, rc, channel: m.ch, member: await peerIdOf(fromB64u(m.r)) };
}

/** The certificate that makes the device with this key a device of the identity in the code. */
export const certifyDevice = ({ recovery, rc }, devicePub, name, now = Date.now()) => (
  makeChainCert(recovery, rc, devicePub, name, now)
);
