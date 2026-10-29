// Linked devices. The main device keeps the identity key and signs a certificate for another
// device's own key. That device then writes "as" the main identity: its messages carry the
// certificate, so everyone can check that the main identity allowed this very key. The
// device's key never leaves it, and the main key never leaves the main device.
// Nothing here needs a server.
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

/** Shape only (no signature check): safe to run on anything received. */
export const certShape = (c) => !!c && typeof c === 'object' && isB64u(c.r, 43)
  && isB64u(c.d, 43) && isB64u(c.sig, 86) && typeof c.n === 'string' && c.n.length <= 32
  && Number.isSafeInteger(c.ms) && c.ms >= 0;

const known = new Map(); // certificates already checked -> the member id they speak for

/** The member id this certificate speaks for, or null if it is malformed or not signed by
 *  its own main key. */
export async function verifyCert(c) {
  if (!certShape(c)) return null;
  const key = `${c.r}|${c.d}|${c.n}|${c.ms}|${c.sig}`;
  if (known.has(key)) return known.get(key);
  const main = fromB64u(c.r);
  const ok = await verifySignature(main, fromB64u(c.sig), text('knot/device', c.d, c.n, c.ms));
  const member = ok ? await peerIdOf(main) : null;
  if (known.size > 256) known.clear();
  known.set(key, member);
  return member;
}

/** On a linked device: speak as the main identity. Does nothing on a main device, or if the
 *  stored certificate is not for this device's key. */
export async function applyDelegation(identity, kv) {
  const record = await kv.get('delegate');
  const member = record ? await verifyCert(record.cert) : null;
  if (member && record.cert.d === toB64u(identity.pub)) {
    Object.assign(identity, { member, cert: record.cert });
  }
  return identity;
}
