// The lobby: how someone with a join link asks the owner to let them in.
//
// A join link carries a lobby secret and the owner's id. The lobby secret is derived from
// the room secret one way, so it can reach the owner but cannot read the room. The owner
// answers with the real room secret, sealed to a one-time key the joiner put in the request
// and signed with the owner's identity. All lobby traffic also travels sealed on the brokers.
//
//   joiner -> owner   { t:'join', pub, name, greeting, box, ts, sig }
//   owner  -> joiner  { t:'grant', to, pub, box, sig }  |  { t:'deny', to, pub, sig }
// A moderator may answer with a grant too (never a refusal): the joiner believes it if the member
// list inside shows that moderator under the owner the link names (see `vouched`).
import { concat, fromB64u, fromUtf8, toB64u, utf8 } from '../util/bytes.js';
import { peerIdOf, verifySignature } from '../crypto/identity.js';
import { verifyCert } from '../crypto/delegation.js';
import { deriveRoomKeys } from '../crypto/room-keys.js';
import { openBox, sealBox } from '../crypto/box.js';
import { authorIdOf, verifyEnvelope } from './envelope.js';
import { Roster } from './roster.js';

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
  // A linked device asks as the identity it writes as: its certificate proves that.
  return utf8.encode(JSON.stringify(
    { ...body, sig: toB64u(sig), ...(identity.cert ? { cert: identity.cert } : {}) },
  ));
}

/** Verified request, or null: { id, device, pub, name, greeting, boxPub, ts, cert? }. `id` is who
 *  asks to be admitted (the main identity for a linked device); `device` is the key that asked,
 *  where the answer goes. */
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
    const device = await peerIdOf(pub);
    let id = device;
    if (m.cert !== undefined) {
      id = m.cert.d === m.pub ? await verifyCert(m.cert) : null;
      if (!id) return null;
    }
    return {
      id, device, pub, name: m.name, greeting: m.greeting, boxPub, ts: m.ts, cert: m.cert,
    };
  } catch { return null; }
}

/** `payload`: { secret: Uint8Array, label, admit: envelope, chain: the member list's envelopes
 *  (the start of it), founder: id of the room's creator, epoch: { n, s } of the current key
 *  rotation, or null } */
export async function makeGrant(identity, { lobbyId, to, boxPub, payload }) {
  const plain = utf8.encode(JSON.stringify({
    secret: toB64u(payload.secret), label: payload.label, admit: payload.admit,
    chain: payload.chain, founder: payload.founder, epoch: payload.epoch,
  }));
  const box = toB64u(await sealBox(boxPub, plain, text('knot/grant', lobbyId, to)));
  const sig = await identity.sign(text('knot/grant-sig', lobbyId, to, box));
  return utf8.encode(JSON.stringify({
    t: 'grant', to, pub: toB64u(identity.pub), box, sig: toB64u(sig),
    ...(identity.cert ? { cert: identity.cert } : {}),
  }));
}

export async function makeDeny(identity, { lobbyId, to }) {
  const sig = await identity.sign(text('knot/deny-sig', lobbyId, to));
  return utf8.encode(JSON.stringify(
    { t: 'deny', to, pub: toB64u(identity.pub), sig: toB64u(sig),
      ...(identity.cert ? { cert: identity.cert } : {}) },
  ));
}

/** A grant from someone who is not the owner: does the member list it carries, rooted in the
 *  room's creator, make `signer` a moderator under `ownerId`, and is the admission it carries
 *  theirs, for us? (The list may be cut short, and nothing proves the moderator was not removed
 *  since: a joiner who is wrongly let in is simply ignored by the members.) */
async function vouched({ secret, founder, chain, admit }, { signer, ownerId, selfId }) {
  if (!Array.isArray(chain) || !admit) return false;
  const roomId = (await deriveRoomKeys(secret)).id;
  for (const env of chain) if (!(await verifyEnvelope(env, roomId))) return false;
  const roster = new Roster(founder);
  roster.load(chain);
  return roster.owner === ownerId && roster.isMod(signer) && admit.kind === 'admit'
    && admit.body.id === selfId && authorIdOf(admit) === signer && verifyEnvelope(admit, roomId);
}

/** The owner's (or a moderator's) answer to us, or null if it is not one (wrong lobby, receiver
 *  or key, or not from someone who may answer).
 *  -> { t:'grant', secret, label, admit, chain, founder, epoch } | { t:'deny' } */
export async function readDecision(bytes, { lobbyId, ownerId, selfId, boxKey }) {
  try {
    const m = JSON.parse(fromUtf8(bytes));
    if (m.to !== selfId) return null;
    const pub = fromB64u(m.pub);
    // The owner's own key, or a device of the owner (its certificate names exactly this key).
    const speaksFor = m.cert ? await verifyCert(m.cert) : await peerIdOf(pub);
    if (!speaksFor || (m.cert && m.cert.d !== m.pub)) return null;
    const byOwner = speaksFor === ownerId;
    const sig = fromB64u(m.sig);
    if (m.t === 'deny') {
      if (!byOwner) return null; // nothing shows that a moderator may refuse
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
    const { secret, label, admit, chain, founder, epoch } = JSON.parse(fromUtf8(plain));
    const room = fromB64u(secret);
    if (room.length !== 16 || typeof founder !== 'string') return null;
    if (!byOwner && !(await vouched(
      { secret: room, founder, chain, admit }, { signer: speaksFor, ownerId, selfId },
    ))) return null;
    return {
      t: 'grant', secret: room, label: String(label), admit, founder, epoch: epoch ?? null,
      chain: Array.isArray(chain) ? chain : [], // an older owner sends none
    };
  } catch { return null; }
}
