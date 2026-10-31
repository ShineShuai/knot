// Linking a device by two codes, with no server in between.
//
//   new device  -> main device   request: its own public key, a one-time sealing key and a name,
//                                signed with its own key
//   main device -> new device    grant: a certificate for that key plus the rooms, sealed to
//                                the one-time key and signed with the main key
//
// Both codes can be shown as QR codes or pasted as text, so a code that passes through a chat
// app is still unreadable to everyone but the new device. Each screen also shows a six-digit
// code derived from all the keys involved: if the two differ, someone swapped a code.
import {
  ByteReader, ByteWriter, concat, fromB64u, fromUtf8, sha256, toB64u, utf8,
} from '../util/bytes.js';
import { makeCert, verifyCert } from '../crypto/delegation.js';
import { openBox, sealBox } from '../crypto/box.js';
import { peerIdOf, verifySignature } from '../crypto/identity.js';

const REQUEST = 'knotdev1-';
const GRANT = 'knotdev2-';
const MAX_AGE_MS = 10 * 60 * 1000;
const MAX_ROOMS = 200;
const B64U = /^[A-Za-z0-9_-]+$/;
const text = (...parts) => utf8.encode(parts.join('|'));
const codeIn = (prefix, input) => new RegExp(`${prefix}([A-Za-z0-9_-]+)`).exec(input ?? '')?.[1];

/** The new device asks. `boxPub`: the public half of a one-time key (crypto/box.js). */
export async function makeLinkRequest(identity, { name, boxPub, now = Date.now() }) {
  const body = {
    pub: toB64u(identity.pub), box: toB64u(boxPub), name: String(name).slice(0, 32), ts: now,
  };
  const sig = await identity.sign(text('knot/link-request', body.box, body.name, body.ts));
  return REQUEST + toB64u(utf8.encode(JSON.stringify({ ...body, sig: toB64u(sig) })));
}

/** A request as text (a code, or text around one) -> { id, pub, boxPub, name, ts }; null if it
 *  is malformed, forged or old. */
export async function readLinkRequest(input, now = Date.now()) {
  try {
    const m = JSON.parse(fromUtf8(fromB64u(codeIn(REQUEST, input))));
    const [pub, boxPub, sig] = [fromB64u(m.pub), fromB64u(m.box), fromB64u(m.sig)];
    if (pub.length !== 32 || boxPub.length !== 32 || typeof m.name !== 'string') return null;
    if (m.name.length > 32 || !Number.isSafeInteger(m.ts) || Math.abs(now - m.ts) > MAX_AGE_MS) {
      return null;
    }
    if (!(await verifySignature(pub, sig, text('knot/link-request', m.box, m.name, m.ts)))) {
      return null;
    }
    return { id: await peerIdOf(pub), pub, boxPub, name: m.name, ts: m.ts };
  } catch { return null; }
}

/** Six digits both screens show; they match only if no code was swapped on the way. */
export async function linkCode(devicePub, mainPub, boxPub) {
  const d = await sha256(concat(utf8.encode('knot/link-code'), devicePub, mainPub, boxPub));
  const n = ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0;
  const s = String(n % 1_000_000).padStart(6, '0');
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}

/**
 * The main device answers a request: `rooms` is a list of { secret, label, founder, epoch }
 * (see Room.exportState); `sync`: what the devices share (see device-sync.js). Returns the code
 * and the six digits to compare.
 */
export async function makeLinkGrant(main, request, { name, rooms, sync = null, now = Date.now() }) {
  const cert = await makeCert(main, request.pub, request.name, now);
  const plain = utf8.encode(JSON.stringify({ cert, name, rooms, sync }));
  const box = await sealBox(request.boxPub, plain, text('knot/link-grant', request.id));
  const sig = await main.sign(concat(text('knot/link-grant-sig', request.id), box));
  const wire = new ByteWriter().u8(1).raw(main.pub).raw(sig).raw(box).done();
  return {
    code: GRANT + toB64u(wire),
    sas: await linkCode(request.pub, main.pub, request.boxPub),
    cert,
  };
}

const validRoom = (r) => !!r && typeof r === 'object' && typeof r.secret === 'string'
  && fromB64u(r.secret).length === 16 && typeof r.label === 'string' && r.label.length <= 40
  && (r.founder === null || (typeof r.founder === 'string' && r.founder.length <= 16))
  && (r.epoch === null || (Number.isSafeInteger(r.epoch?.n) && B64U.test(r.epoch?.s ?? '')));

/**
 * The new device reads the grant: { cert, name, rooms, sync, mainId, sas }, or null if it is not
 * addressed to this device, was not signed by the main key it names, or its certificate is not
 * for this device's key. `boxKey`: the one-time key whose public half went into the request.
 */
export async function readLinkGrant(input, { identity, boxKey, boxPub }) {
  try {
    const r = new ByteReader(fromB64u(codeIn(GRANT, input)));
    if (r.u8() !== 1) return null;
    const mainPub = r.raw(32).slice();
    const sig = r.raw(64).slice();
    const box = r.raw(r.remaining).slice();
    const signed = concat(text('knot/link-grant-sig', identity.id), box);
    if (!(await verifySignature(mainPub, sig, signed))) return null;
    const plain = await openBox(boxKey.privateKey, box, text('knot/link-grant', identity.id));
    const { cert, name, rooms, sync } = JSON.parse(fromUtf8(plain));
    const mainId = await peerIdOf(mainPub);
    const member = await verifyCert(cert);
    if (member !== mainId || cert.d !== toB64u(identity.pub) || toB64u(mainPub) !== cert.r) {
      return null;
    }
    if (typeof name !== 'string' || !Array.isArray(rooms) || rooms.length > MAX_ROOMS) return null;
    if (!rooms.every(validRoom)) return null;
    const sas = await linkCode(identity.pub, mainPub, boxPub);
    return { cert, name: name.slice(0, 32), rooms, mainId, sas, sync: sync ?? null };
  } catch { return null; }
}
