// A Handshake is one signed signaling message (offer or answer). It is the only
// thing two peers must exchange, whether by QR code, pasted text or a broker.
//
//   { kind, pub, session, ts, name, roomSecret|null, sdp:SdpInfo, sig, body, wire }
//
// Wire format (binary, then base64url): see packBody(). The signature covers
// everything before it, so the identity key vouches for the DTLS fingerprint.
import { ByteReader, ByteWriter, concat, fromB64u, sha256, toB64u } from '../util/bytes.js';
import { peerIdOf, verifySignature } from '../crypto/identity.js';

const VERSION = 1;
const CODE_PREFIX = 'knot1-';
const MAX_CANDIDATES = 8;
export const HANDSHAKE_TTL_MS = 10 * 60 * 1000;
const CANDIDATE_TYPES = ['host', 'srflx', 'relay', 'prflx'];
const ADDR = { V4: 0, V6: 1, MDNS: 2 };
const ADDR_LENGTH = [4, 16, 16];
const MDNS_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.local$/i;

// ---- candidate addresses -------------------------------------------------

function packAddress(host) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const parts = host.split('.').map(Number);
    return parts.every((n) => n <= 255) ? { kind: ADDR.V4, bytes: Uint8Array.from(parts) } : null;
  }
  const mdns = MDNS_NAME.exec(host);
  if (mdns) return {
    kind: ADDR.MDNS,
    bytes: Uint8Array.from(mdns[1].replaceAll('-', '').match(/../g), (h) => parseInt(h, 16)),
  };
  const v6 = host.includes(':') ? ipv6ToBytes(host) : null;
  return v6 ? { kind: ADDR.V6, bytes: v6 } : null;
}

function ipv6ToBytes(host) {
  host = host.split('%')[0];
  // IPv4-mapped / link-local: not useful remotely
  if (host.includes('.') || /^fe80:/i.test(host)) return null;
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (s) => (s ? s.split(':') : []);
  const [head, tail] = [groupsOf(halves[0]), groupsOf(halves[1])];
  let groups;
  if (halves.length === 1) groups = head;
  else if (head.length + tail.length < 8) groups = [
    ...head,
    ...Array(8 - head.length - tail.length).fill('0'),
    ...tail
  ];
  if (groups?.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  return Uint8Array.from(groups.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 255]));
}

function unpackAddress(kind, b) {
  const hex = (bytes) => [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('');
  if (kind === ADDR.V4) return [...b].join('.');
  if (kind === ADDR.V6) return Array.from(
    { length: 8 },
    (_, i) => ((b[2 * i] << 8) | b[2 * i + 1]).toString(16),
  ).join(':');
  const h = hex(b);
  const groups = [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)];
  return `${groups.join('-')}.local`;
}

// ---- wire format ----------------------------------------------------------

function packBody(h) {
  const { sdp } = h;
  if (sdp.fingerprint.length !== 32) throw new Error('fingerprint must be SHA-256');
  const w = new ByteWriter()
    .u8(VERSION)
    .u8((h.kind === 'answer' ? 1 : 0) | (h.roomSecret ? 2 : 0))
    .raw(h.pub)
    .raw(h.session)
    .u32(Math.floor(h.ts / 1000));
  if (h.roomSecret) w.raw(h.roomSecret);
  w.str(h.name.slice(0, 32)).str(sdp.ufrag).str(sdp.pwd).str(sdp.mid)
    .raw(sdp.fingerprint).u16(sdp.sctpPort).u32(sdp.maxMessage);
  const candidates = sdp.candidates
    .map((c) => ({ c, a: packAddress(c.host) }))
    .filter(({ a }) => a)
    .slice(0, MAX_CANDIDATES);
  w.u8(candidates.length);
  for (const { c, a } of candidates) w.u8(
    (CANDIDATE_TYPES.indexOf(c.type) << 2) | a.kind,
  ).raw(a.bytes).u16(c.port);
  return w.done();
}

export function unpackHandshake(wire) {
  if (wire.length < 64 + 48) throw new Error('Code is too short');
  const body = wire.slice(0, -64);
  const sig = wire.slice(-64);
  const r = new ByteReader(body);
  if (r.u8() !== VERSION) throw new Error('Unsupported code version');
  const flags = r.u8();
  const h = {
    kind: flags & 1 ? 'answer' : 'offer',
    pub: r.raw(32).slice(),
    session: r.raw(8).slice(),
    ts: r.u32() * 1000,
  };
  h.roomSecret = flags & 2 ? r.raw(16).slice() : null;
  h.name = r.str();
  const sdp = {
    ufrag: r.str(),
    pwd: r.str(),
    mid: r.str(),
    fingerprint: r.raw(32).slice(),
    sctpPort: r.u16(),
    maxMessage: r.u32(),
    candidates: [],
  };
  for (let n = r.u8(); n > 0; n--) {
    const b = r.u8();
    const type = CANDIDATE_TYPES[b >> 2];
    const kind = b & 3;
    if (!type || kind > ADDR.MDNS) throw new Error('Bad candidate');
    sdp.candidates.push(
      { type, host: unpackAddress(kind, r.raw(ADDR_LENGTH[kind])), port: r.u16() },
    );
  }
  if (r.remaining) throw new Error('Unexpected trailing data');
  return { ...h, sdp, sig, body, wire };
}

// ---- signing & codes ---------------------------------------------------------

/** fields: { kind, session, ts, name, roomSecret|null, sdp } */
export async function signHandshake(identity, fields) {
  const h = { ...fields, pub: identity.pub };
  const body = packBody(h);
  const sig = await identity.sign(body);
  return { ...h, sig, body, wire: concat(body, sig) };
}

/** Throws unless signature and age are valid. Returns the sender's peer id. */
export async function verifyHandshake(h, { now = Date.now(), ttlMs = HANDSHAKE_TTL_MS } = {}) {
  if (!(await verifySignature(h.pub, h.sig, h.body))) throw new Error('Signature check failed');
  if (Math.abs(now - h.ts) > ttlMs) throw new Error('Code has expired');
  return peerIdOf(h.pub);
}

export const encodeCode = (h) => CODE_PREFIX + toB64u(h.wire);

/** Accepts a bare code, a link containing one, or text around one. Returns null if none found. */
export function decodeCode(text) {
  const m = /knot1-([A-Za-z0-9_-]+)/.exec(text ?? '');
  if (!m) return null;
  try { return unpackHandshake(fromB64u(m[1])); } catch { return null; }
}

/** Short authentication string: both sides show the same 6 digits derived from
 *  both DTLS fingerprints; if they differ, someone tampered with the exchange. */
export async function shortAuthString(fpA, fpB) {
  const [lo, hi] = [fpA, fpB].sort(
    (x, y) => { for (let i = 0; i < 32; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; },
  );
  const d = await sha256(concat(lo, hi));
  const n = ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0;
  const s = String(n % 1_000_000).padStart(6, '0');
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}
