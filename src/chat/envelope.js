// A chat envelope is one signed, self-contained message. It can travel over any
// path (P2P link, broker relay, history sync) and be verified by anyone in the room.
//
//   { v, id, room, kind:'text'|'reply'|'file'|'del'|'edit'|'react'|<admin kinds>, name, ms, c,
//     body, pub, sig }
//
// id = "<ms36>-<counter36>-<authorPeerId>", so the id itself pins author and stamp.
import { fromB64u, toB64u, utf8 } from '../util/bytes.js';
import { peerIdOf, verifySignature } from '../crypto/identity.js';
import { MAX_FUTURE_MS } from '../util/hlc.js';
import { LIMITS, PREVIEW_TYPES, THUMB_TYPES } from '../files/image.js';

const B64U = /^[A-Za-z0-9_-]+$/;
const signingBytes = (e) => utf8.encode(
  JSON.stringify([e.v, e.id, e.room, e.kind, e.name, e.ms, e.c, e.body, e.pub]),
);

/** Metadata for a shared file. Key order matters for the signature; build it only here.
 *  Images carry `img` = { w, h, t: inline thumbnail, tm: its mime, a?: animated,
 *  p?: { id, size, mime, sha256 } of a separately fetched preview }. */
export const fileBody = ({ id, name, size, mime, sha256, img }) => (
  img ? { id, name, size, mime, sha256, img: imgBody(img) } : { id, name, size, mime, sha256 }
);
const imgBody = ({ w, h, t, tm, a, p }) => ({
  w, h, t, tm,
  ...(a ? { a: 1 } : {}),
  ...(p ? { p: { id: p.id, size: p.size, mime: p.mime, sha256: p.sha256 } } : {}),
});

/** Body of a text message that quotes another message: `q` is a snapshot of the quoted
 *  one (id, author name, first 200 characters), so it reads right even if that one is gone. */
export const replyBody = (text, { id, name, text: snippet }) => (
  { text, q: { id, name, text: snippet } }
);
/** Body of a deletion ("recall") of message `id` (its author, or the room owner, may do it;
 *  the room enforces who, see Room). */
export const delBody = (id) => ({ id });
/** Body of an edit: the new text of message `id`. Only its author may edit it; the latest edit
 *  wins. The original stays in the log (use delete to remove content). */
export const editBody = (id, text) => ({ id, text });
/** Body of a reaction: `emoji` on message `id` is switched `on` or off by the author. For one
 *  author, message and emoji only the latest such envelope counts. */
export const reactBody = (id, emoji, on) => ({ id, emoji, on });

// One pictograph, optionally with skin tone, variation selector or joined (ZWJ) pictographs.
const EMOJI =
  /^\p{Extended_Pictographic}(?:\uFE0F|[\u{1F3FB}-\u{1F3FF}]|\u200D\p{Extended_Pictographic})*$/u;
export const isEmoji = (s) => typeof s === 'string' && s.length <= 16 && EMOJI.test(s);

/** Owner-signed membership changes, forming a chain through `prev` (see roster.js). They
 *  are never trimmed from the log: membership must outlive the chat history. */
export const ADMIN_KINDS = Object.freeze(
  ['admit', 'revoke', 'transfer', 'recovery', 'recover'],
);
export const admitBody = ({ id, name }, prev) => ({ id, name, prev });
/** `epoch` { n, commit }: the channel keys rotate; `commit` is the hash of the new secret. */
export const revokeBody = ({ id, epoch }, prev) => (
  epoch ? { id, epoch: { n: epoch.n, commit: epoch.commit }, prev } : { id, prev }
);
export const transferBody = ({ to }, prev) => ({ to, prev });
/** Registers the public key of the owner's recovery code. */
export const recoveryBody = ({ key }, prev) => ({ key, prev });
/** Signed by the recovery key: `to` becomes the owner, the old owner is removed. */
export const recoverBody = ({ to, epoch }, prev) => (
  { to, epoch: { n: epoch.n, commit: epoch.commit }, prev }
);

/** What a quote of `env` shows. `shown`: the text to use (the latest edit), if not the original. */
export function quoteOf(env, shown = null) {
  const { body } = env;
  const text = shown ?? (env.kind === 'file' ? body.name : env.kind === 'reply' ? body.text : body);
  return { id: env.id, name: env.name, text: text.replace(/\s+/g, ' ').trim().slice(0, 200) };
}

/** Where the small viewable rendition of a shared image lives ({ id, size, mime, sha256 },
 *  fetched like a file), or null. Without a separate preview, a small original is its own. */
export function previewRef(body) {
  const { img } = body;
  if (!img) return null;
  if (img.p) return img.p;
  const { id, size, mime, sha256 } = body;
  return size <= LIMITS.ownPreviewMax ? { id, size, mime, sha256 } : null;
}

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

const isB64u = (s, length) => typeof s === 'string' && s.length === length && B64U.test(s);

/** Shape and size limits only; whether the thumbnail really is an image is checked
 *  (by sniffing its bytes) when it is shown, so a bad one never hides the message. */
function validImg(i) {
  const dim = (n) => Number.isSafeInteger(n) && n >= 1 && n <= 65535;
  if (!i || typeof i !== 'object' || !dim(i.w) || !dim(i.h)) return false;
  const maxChars = Math.ceil((LIMITS.thumbMax * 4) / 3);
  if (typeof i.t !== 'string' || !i.t || i.t.length > maxChars || !B64U.test(i.t)) return false;
  if (!THUMB_TYPES.includes(i.tm) || (i.a !== undefined && i.a !== 1)) return false;
  const p = i.p;
  return p === undefined || (
    !!p && typeof p === 'object' && isB64u(p.id, 11) && isB64u(p.sha256, 43) &&
    Number.isSafeInteger(p.size) && p.size > 0 && p.size <= LIMITS.previewMax &&
    PREVIEW_TYPES.includes(p.mime)
  );
}

const isMessageId = (id) => typeof id === 'string' && id.length <= 64 && id.split('-').length >= 3;

function validQuote(q) {
  return !!q && typeof q === 'object' && isMessageId(q.id) && typeof q.name === 'string'
    && q.name.length <= 64 && typeof q.text === 'string' && q.text.length <= 200;
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
  if (e.kind === 'reply') {
    const b = e.body;
    return !!b && typeof b === 'object' && typeof b.text === 'string' && b.text.length > 0
      && b.text.length <= maxText && validQuote(b.q);
  }
  if (e.kind === 'del') { // who may delete what is decided by the room (author or owner)
    const id = e.body?.id;
    return isMessageId(id) && id !== e.id;
  }
  if (e.kind === 'edit') {
    const b = e.body;
    return !!b && typeof b === 'object' && isMessageId(b.id) && b.id !== e.id
      && typeof b.text === 'string' && b.text.length > 0 && b.text.length <= maxText;
  }
  if (e.kind === 'react') {
    const b = e.body;
    return !!b && typeof b === 'object' && isMessageId(b.id) && b.id !== e.id
      && isEmoji(b.emoji) && typeof b.on === 'boolean';
  }
  if (ADMIN_KINDS.includes(e.kind)) {
    const b = e.body;
    const prev = typeof b?.prev === 'string' && (b.prev === '' || isMessageId(b.prev));
    const peer = (id) => isB64u(id, 11);
    const epoch = (x) => !!x && Number.isSafeInteger(x.n) && x.n >= 1 && x.n <= 1e6
      && isB64u(x.commit, 43);
    if (!prev) return false;
    if (e.kind === 'admit') return peer(b.id) && typeof b.name === 'string' && b.name.length <= 32;
    if (e.kind === 'revoke') return peer(b.id) && (b.epoch === undefined || epoch(b.epoch));
    if (e.kind === 'recovery') return isB64u(b.key, 43);
    if (e.kind === 'recover') return peer(b.to) && epoch(b.epoch);
    return peer(b.to);
  }
  if (e.kind === 'file') {
    const b = e.body;
    return !!b && typeof b === 'object' && typeof b.id === 'string' && b.id.length === 11 &&
      B64U.test(
      b.id,
    )
      && typeof b.name === 'string' && b.name.length > 0 && b.name.length <= 255
      && isInt(b.size, maxFileBytes) && typeof b.mime === 'string' && b.mime.length <= 100
      && typeof b.sha256 === 'string' && b.sha256.length === 43 && B64U.test(b.sha256)
      && (b.img === undefined || validImg(b.img));
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
export const authorOfId = (id) => id.split('-').slice(2).join('-');
export const authorIdOf = (env) => authorOfId(env.id);
