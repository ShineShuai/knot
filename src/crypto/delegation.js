// Linked devices. The original device keeps the identity key and signs a certificate for another
// device's own key. That device then writes "as" the main identity: its messages carry the
// certificate, so everyone can check that the main identity allowed this very key. The
// device's key never leaves it, and the main key never leaves the original device.
// Nothing here needs a server.
//
// One more link in the chain keeps the identity alive when the main key is lost: while the main
// device still works it signs a recovery certificate for a recovery key, whose seed the person
// keeps offline as a code (crypto/identity-recovery.js). That key may then sign device
// certificates in the main key's place. A device certificate of that kind carries the recovery
// certificate (`up`), so anyone can check main -> recovery key -> device. One hop only.
import { fromB64u, toB64u, utf8 } from '../util/bytes.js';
import { peerIdOf, verifySignature } from './identity.js';

const text = (...parts) => utf8.encode(parts.join('|'));
const B64U = /^[A-Za-z0-9_-]+$/;
const isB64u = (s, length) => typeof s === 'string' && s.length === length && B64U.test(s);

/** A certificate: { r: main public key, d: device public key, n: device name, ms, sig }. */
export async function makeCert(main, devicePub, name, now = Date.now()) {
  const d = toB64u(devicePub);
  const n = String(name).slice(0, 32);
  const sig = await main.sign(text('knot/device', d, n, now));
  return { r: toB64u(main.pub), d, n, ms: now, sig: toB64u(sig) };
}

/** A recovery certificate: { r: main public key, q: recovery public key, ms, sig }, signed by
 *  the main key ("this key may certify devices for me"). */
export async function makeRecoveryCert(main, recoveryPub, now = Date.now()) {
  const q = toB64u(recoveryPub);
  const sig = await main.sign(text('knot/recovery', q, now));
  return { r: toB64u(main.pub), q, ms: now, sig: toB64u(sig) };
}

/** A device certificate signed by the recovery key `recovery` (an Identity) under the
 *  recovery certificate `rc`: it speaks for the main key, like one the main key signed. */
export async function makeChainCert(recovery, rc, devicePub, name, now = Date.now()) {
  return { ...(await makeCert(recovery, devicePub, name, now)), r: rc.r, up: rc };
}

/** Shape only (no signature check): safe to run on anything received. */
export const recoveryShape = (c) => !!c && typeof c === 'object' && !Array.isArray(c)
  && Object.keys(c).length === 4 && isB64u(c.r, 43) && isB64u(c.q, 43) && isB64u(c.sig, 86)
  && Number.isSafeInteger(c.ms) && c.ms >= 0;

/** Shape only (no signature check): safe to run on anything received. */
export const certShape = (c) => !!c && typeof c === 'object' && isB64u(c.r, 43)
  && isB64u(c.d, 43) && isB64u(c.sig, 86) && typeof c.n === 'string' && c.n.length <= 32
  && Number.isSafeInteger(c.ms) && c.ms >= 0
  && (c.up === undefined || (recoveryShape(c.up) && c.up.r === c.r));

/** Did the main key sign this recovery certificate? */
export const verifyRecoveryCert = async (c) => recoveryShape(c)
  && verifySignature(fromB64u(c.r), fromB64u(c.sig), text('knot/recovery', c.q, c.ms));

const known = new Map(); // certificates already checked -> the member id they speak for

/** The member id this certificate speaks for, or null if it is malformed or not signed by
 *  its own main key (directly, or through a recovery key the main key authorized). */
export async function verifyCert(c) {
  if (!certShape(c)) return null;
  const up = c.up ? `${c.up.q}|${c.up.ms}|${c.up.sig}` : '';
  const key = `${c.r}|${c.d}|${c.n}|${c.ms}|${c.sig}|${up}`;
  if (known.has(key)) return known.get(key);
  const main = fromB64u(c.r);
  const signer = c.up ? fromB64u(c.up.q) : main; // who signed the device certificate
  const ok = (!c.up || await verifyRecoveryCert(c.up))
    && await verifySignature(signer, fromB64u(c.sig), text('knot/device', c.d, c.n, c.ms));
  const member = ok ? await peerIdOf(main) : null;
  if (known.size > 256) known.clear();
  known.set(key, member);
  return member;
}

/** On a linked device: speak as the main identity. Does nothing on an original device, or if the
 *  stored certificate is not for this device's key. */
export async function applyDelegation(identity, kv) {
  const record = await kv.get('delegate');
  if (record?.cert?.r !== undefined && record.cert.r === record.cert.d) {
    await kv.delete('delegate'); // a device linked to itself (an old mistake): not a link at all
    return identity;
  }
  const member = record ? await verifyCert(record.cert) : null;
  if (member && record.cert.d === toB64u(identity.pub)) {
    Object.assign(identity, { member, cert: record.cert });
  }
  return identity;
}
