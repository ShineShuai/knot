// A chat envelope is one signed, self-contained message. It can travel over any
// path (P2P link, broker relay, history sync) and be verified by anyone in the room.
//
//   { v, id, room, kind:'text'|'file', name, ms, c, body, pub, sig }
//
// id = "<ms36>-<counter36>-<authorPeerId>", so the id itself pins author and stamp.
import { fromB64u, toB64u, utf8 } from '../util/bytes.js';
import { peerIdOf, verifySignature } from '../crypto/identity.js';
import { MAX_FUTURE_MS } from '../util/hlc.js';

const B64U = /^[A-Za-z0-9_-]+$/;
const signingBytes = (e) => utf8.encode(
  JSON.stringify([e.v, e.id, e.room, e.kind, e.name, e.ms, e.c, e.body, e.pub]),
);

/** Metadata for a shared file. Key order matters for the signature; build it only here. */
export const fileBody = ({ id, name, size, mime, sha256 }) => ({ id, name, size, mime, sha256 });

export async function createEnvelope(identity, hlc, roomId, kind, body, name) {
  const { ms, c } = hlc.tick();
  const env = {
    v: 1,
    id: `${ms.toString(36)}-${c.toString(36)}-${identity.id}`,
    room: roomId,
    kind,
    name,
    ms,
    c,
    body,
    pub: toB64u(identity.pub),
  };
  return { ...env, sig: toB64u(await identity.sign(signingBytes(env))) };
}

function wellFormed(e, roomId, { maxText, maxFileBytes, now }) {
  const isInt = (n, max) => Number.isSafeInteger(n) && n >= 0 && n <= max;
  if (!e || typeof e !== 'object' || e.v !== 1 || e.room !== roomId) return false;
  if (typeof e.id !== 'string' || e.id.length > 64 || typeof e.name !== 'string' ||
    e.name.length > 64) return false;
  if (!isInt(e.ms, now + MAX_FUTURE_MS) || !isInt(e.c, 1e9)) return false;
  if (typeof e.pub !== 'string' || e.pub.length !== 43 || !B64U.test(e.pub)) return false;
  if (typeof e.sig !== 'string' || e.sig.length !== 86 || !B64U.test(e.sig)) return false;
  if (e.kind === 'text') return typeof e.body === 'string' && e.body.length > 0 &&
    e.body.length <= maxText;
  if (e.kind === 'file') {
    const b = e.body;
    return !!b && typeof b === 'object' && typeof b.id === 'string' && b.id.length === 11 &&
      B64U.test(
      b.id,
    )
      && typeof b.name === 'string' && b.name.length > 0 && b.name.length <= 255
      && isInt(b.size, maxFileBytes) && typeof b.mime === 'string' && b.mime.length <= 100
      && typeof b.sha256 === 'string' && b.sha256.length === 43 && B64U.test(b.sha256);
  }
  return false;
}

/** True only if the envelope is well-formed, belongs to the room, its id matches
 *  its author and stamp, and the author's signature is valid. */
export async function verifyEnvelope(e, roomId, limits = {}) {
  const lim = { maxText: 4000, maxFileBytes: 100 * 1024 * 1024, now: Date.now(), ...limits };
  if (!wellFormed(e, roomId, lim)) return false;
  const pub = fromB64u(e.pub);
  if (e.id !== `${e.ms.toString(36)}-${e.c.toString(36)}-${await peerIdOf(pub)}`) return false;
  return verifySignature(pub, fromB64u(e.sig), signingBytes(e));
}

// id = <ms36>-<counter36>-<peerId>; peer ids are base64url and may themselves contain '-'.
export const authorIdOf = (env) => env.id.split('-').slice(2).join('-');
