// The lobby: how someone with a join link asks the owner to let them in.
//
// A join link carries a lobby secret and the owner's id. The lobby secret is derived from
// the room secret one way, so it can reach the owner but cannot read the room. The owner
// answers with the real room secret, sealed to a one-time key the joiner put in the request
// and signed with the owner's identity. All lobby traffic also travels sealed on the brokers.
//
//   joiner -> owner   { t:'join', pub, name, greeting, box, ts, sig }
//   owner  -> joiner  { t:'grant', to, pub, box, sig }  |  { t:'deny', to, pub, sig }
import { concat, fromB64u, fromUtf8, toB64u, utf8 } from '../util/bytes.js';
import { peerIdOf, verifySignature } from '../crypto/identity.js';
import { deriveRoomKeys } from '../crypto/room-keys.js';
import { openBox, sealBox } from '../crypto/box.js';

export const MAX_GREETING = 200;
const MAX_AGE_MS = 10 * 60 * 1000;
const text = (...parts) => utf8.encode(parts.join('|'));

/** One-way: knowing the lobby secret does not reveal the room secret. */
export async function lobbySecretOf(roomSecret) {
  const base = await crypto.subtle.importKey('raw', roomSecret, 'HKDF', false, ['deriveBits']);
  const params = {
    name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8.encode('knot/lobby'),
  };
  return new Uint8Array(await crypto.subtle.deriveBits(params, base, 128));
}

/** Topic id and sealing key of a lobby; bound to the owner, so a forged owner id in a link
 *  leads to a different (useless) lobby. */
export const lobbyKeys = (lobbySecret, ownerId) => (
  deriveRoomKeys(concat(lobbySecret, utf8.encode(`owner:${ownerId}`)))
);

export async function makeRequest(identity, { lobbyId, name, greeting, boxPub, now = Date.now() }) {
  const body = {
    t: 'join',
    pub: toB64u(identity.pub),
    name: name.slice(0, 32),
    greeting: greeting.slice(0, MAX_GREETING),
    box: toB64u(boxPub),
    ts: now,
  };
  const sig = await identity.sign(
    text('knot/join', lobbyId, body.name, body.greeting, body.box, body.ts),
  );
  return utf8.encode(JSON.stringify({ ...body, sig: toB64u(sig) }));
}

/** Verified request, or null: { id, pub, name, greeting, boxPub, ts }. */
export async function readRequest(bytes, lobbyId, now = Date.now()) {
  try {
    const m = JSON.parse(fromUtf8(bytes));
    if (m.t !== 'join' || typeof m.name !== 'string' || typeof m.greeting !== 'string') return null;
    if (m.greeting.length > MAX_GREETING || m.name.length > 32) return null;
    if (!Number.isFinite(m.ts)) return null;
    if (Math.abs(now - m.ts) > MAX_AGE_MS) return null;
    const pub = fromB64u(m.pub);
    const sig = fromB64u(m.sig);
    const ok = await verifySignature(
      pub, sig, text('knot/join', lobbyId, m.name, m.greeting, m.box, m.ts),
    );
    const boxPub = fromB64u(m.box);
    if (!ok || pub.length !== 32 || boxPub.length !== 32) return null;
    return {
      id: await peerIdOf(pub), pub, name: m.name, greeting: m.greeting, boxPub, ts: m.ts,
    };
  } catch { return null; }
}

/** `payload`: { secret: Uint8Array, label, admit: envelope, founder: id of the room's creator } */
export async function makeGrant(identity, { lobbyId, to, boxPub, payload }) {
  const plain = utf8.encode(JSON.stringify({
    secret: toB64u(payload.secret), label: payload.label, admit: payload.admit,
    founder: payload.founder,
  }));
  const box = toB64u(await sealBox(boxPub, plain, text('knot/grant', lobbyId, to)));
  const sig = await identity.sign(text('knot/grant-sig', lobbyId, to, box));
  return utf8.encode(JSON.stringify({
    t: 'grant', to, pub: toB64u(identity.pub), box, sig: toB64u(sig),
  }));
}

export async function makeDeny(identity, { lobbyId, to }) {
  const sig = await identity.sign(text('knot/deny-sig', lobbyId, to));
  return utf8.encode(JSON.stringify(
    { t: 'deny', to, pub: toB64u(identity.pub), sig: toB64u(sig) },
  ));
}

/** The owner's answer to us, or null if it is not one (wrong lobby, owner, receiver or key).
 *  -> { t:'grant', secret, label, admit, founder } | { t:'deny' } */
export async function readDecision(bytes, { lobbyId, ownerId, selfId, boxKey }) {
  try {
    const m = JSON.parse(fromUtf8(bytes));
    if (m.to !== selfId) return null;
    const pub = fromB64u(m.pub);
    if ((await peerIdOf(pub)) !== ownerId) return null;
    const sig = fromB64u(m.sig);
    if (m.t === 'deny') {
      return (await verifySignature(pub, sig, text('knot/deny-sig', lobbyId, selfId)))
        ? { t: 'deny' } : null;
    }
    if (m.t !== 'grant') return null;
    if (!(await verifySignature(pub, sig, text('knot/grant-sig', lobbyId, selfId, m.box)))) {
      return null;
    }
    const plain = await openBox(
      boxKey.privateKey, fromB64u(m.box), text('knot/grant', lobbyId, selfId),
    );
    const { secret, label, admit, founder } = JSON.parse(fromUtf8(plain));
    const room = fromB64u(secret);
    if (room.length !== 16 || typeof founder !== 'string') return null;
    return { t: 'grant', secret: room, label: String(label), admit, founder };
  } catch { return null; }
}
