// A backup of what a person cannot get back from anywhere else: the settings, the room list
// with the keys that open the rooms, and the signed messages. Left out: the identity key (the
// browser does not give it out, on purpose, so after a restore the person is a new device in
// their rooms and the owner, or a recovery code, lets them in again), links to other devices,
// shared files and previews. The file is encrypted: AES-GCM under a key made from a passphrase
// (PBKDF2), with the header authenticated.
import { DEFAULTS, networkProblems } from '../config.js';
import { verifyEnvelope } from '../chat/envelope.js';
import { deriveRoomKeys } from '../crypto/room-keys.js';
import { VERSION } from '../version.js';
import { concat, fromB64u, fromUtf8, randomBytes, utf8 } from '../util/bytes.js';

const FORMAT = 'knot-backup';
const FILE_VERSION = 1;
const MAGIC = utf8.encode('KNOTBK1\n');
const [SALT, IV, TAG] = [16, 12, 16];
const HEAD = MAGIC.length + 4 + SALT; // magic, iterations (u32), salt
export const ITERATIONS = 600_000; // PBKDF2-SHA-256, the OWASP figure for 2023
const [MIN_ITERATIONS, MAX_ITERATIONS] = [1000, 2_000_000]; // a crafted file must not hang us
const MAX_ROOMS = 200;
export const MIN_PASSPHRASE = 8;
export const FILE_EXT = '.knotbk';

/** `code`: not_a_backup | wrong_passphrase | newer | damaged | empty_passphrase (i18n
 *  `backupErr_<code>`). */
export class BackupError extends Error {
  constructor(code) {
    super(code);
    this.name = 'BackupError';
    this.code = code;
  }
}

const B64U = /^[A-Za-z0-9_-]+$/;

/** Is this key of the store part of a backup? */
export const isBackupKey = (key) => key === 'settings' || key === 'rooms'
  || /^(epoch|owner|read|m):/.test(key);

/** What a backup holds, as { entries: [[key, value]], ... } (JSON all the way). */
export async function collect(kv, now = Date.now()) {
  const entries = [];
  for (const key of ['settings', 'rooms']) {
    const value = await kv.get(key);
    if (value !== undefined) entries.push([key, value]);
  }
  for (const prefix of ['epoch:', 'owner:', 'read:', 'm:']) entries.push(...await kv.list(prefix));
  return { format: FORMAT, version: FILE_VERSION, app: VERSION, at: now, entries };
}

/** How many rooms and messages a snapshot holds. */
export function countOf(snapshot) {
  const rooms = snapshot.entries.find(([key]) => key === 'rooms')?.[1];
  return {
    rooms: Array.isArray(rooms) ? rooms.length : 0,
    messages: snapshot.entries.filter(([key]) => key.startsWith('m:')).length,
  };
}

/** The key made from a passphrase (never readable by the page), with what the file header needs
 *  to make it again. */
export async function backupSecret(
  passphrase, { salt = randomBytes(SALT), iterations = ITERATIONS } = {},
) {
  if (typeof passphrase !== 'string' || !passphrase) throw new BackupError('empty_passphrase');
  if (!(iterations >= MIN_ITERATIONS && iterations <= MAX_ITERATIONS)) {
    throw new BackupError('damaged');
  }
  const { subtle } = globalThis.crypto;
  const base = await subtle.importKey(
    'raw', utf8.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey'],
  );
  const key = await subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { key, salt, iterations };
}

/** The file: header, a fresh IV, the encrypted snapshot. */
export async function seal(snapshot, { key, salt, iterations }) {
  const head = concat(MAGIC,
    Uint8Array.of(iterations >>> 24, iterations >>> 16, iterations >>> 8, iterations), salt);
  const iv = randomBytes(IV);
  const body = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: head }, key, utf8.encode(JSON.stringify(snapshot)),
  );
  return concat(head, iv, new Uint8Array(body));
}

/** The key parameters in a file's header (to make the key for it). */
export function readHeader(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < HEAD + IV + TAG
    || !MAGIC.every((b, i) => bytes[i] === b)) throw new BackupError('not_a_backup');
  const at = MAGIC.length;
  const iterations = ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8)
    | bytes[at + 3]) >>> 0;
  return { iterations, salt: bytes.slice(at + 4, HEAD) };
}

/** Decrypt a file with a key made for its header (`backupSecret` with `readHeader`'s values). */
export async function openWith(bytes, { key }) {
  readHeader(bytes);
  let plain;
  try {
    plain = await globalThis.crypto.subtle.decrypt({
      name: 'AES-GCM', iv: bytes.subarray(HEAD, HEAD + IV), additionalData: bytes.subarray(0, HEAD),
    }, key, bytes.subarray(HEAD + IV));
  } catch { throw new BackupError('wrong_passphrase'); } // or a file that was changed
  let snapshot;
  try { snapshot = JSON.parse(fromUtf8(new Uint8Array(plain))); } catch {
    throw new BackupError('damaged');
  }
  if (snapshot?.format !== FORMAT || !Array.isArray(snapshot.entries)) {
    throw new BackupError('damaged');
  }
  if (!(snapshot.version >= 1) || snapshot.version > FILE_VERSION) throw new BackupError('newer');
  return snapshot;
}

/** Decrypt a file with a passphrase. */
export async function open(bytes, passphrase) {
  const { iterations, salt } = readHeader(bytes);
  return openWith(bytes, await backupSecret(passphrase, { salt, iterations }));
}

const sameKind = (a, b) => (Array.isArray(b) ? Array.isArray(a) : typeof a === typeof b);

/** Only settings this version knows, of the kind it expects; a network list that would not
 *  pass the Settings page is left out (a backup must not point the app at somebody's server). */
function cleanSettings(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, standard] of Object.entries(DEFAULTS)) {
    if (key in raw && sameKind(raw[key], standard)) out[key] = raw[key];
  }
  if (networkProblems({ ...DEFAULTS, ...out }).length) {
    for (const key of ['stunServers', 'brokers', 'turnServers']) delete out[key];
  }
  return out;
}

const goodEpoch = (e) => !!e && Number.isSafeInteger(e.n) && e.n >= 1 && e.n <= 1e6
  && typeof e.s === 'string' && e.s.length === 22 && B64U.test(e.s);
const goodId = (s) => typeof s === 'string' && s.length > 0 && s.length <= 100;

/** Put a snapshot into the store without overwriting what is there: new rooms are added,
 *  messages already held stay, a key epoch only moves forward, settings of the backup win.
 *  Messages are signature-checked like any that arrives from a peer. Resolves to how many
 *  rooms and messages were added and how many messages were refused. */
export async function restore(kv, snapshot, { progress = () => {} } = {}) {
  const entries = new Map(
    snapshot.entries.filter((e) => Array.isArray(e) && typeof e[0] === 'string'),
  );
  const done = { rooms: 0, messages: 0, skipped: 0 };
  const settings = cleanSettings(entries.get('settings'));
  if (Object.keys(settings).length) {
    await kv.put('settings', { ...((await kv.get('settings')) ?? {}), ...settings });
  }

  const have = (await kv.get('rooms')) ?? [];
  const known = new Set(have.map((r) => r.secret));
  const asked = entries.get('rooms');
  const listed = Array.isArray(asked) ? asked.slice(0, MAX_ROOMS) : [];
  const added = [];
  const ids = new Set();
  for (const r of listed) {
    if (typeof r?.secret !== 'string' || !B64U.test(r.secret) || r.secret.length > 64) continue;
    try { ids.add((await deriveRoomKeys(fromB64u(r.secret))).id); } catch { continue; }
    if (known.has(r.secret)) continue;
    known.add(r.secret);
    const label = String(r.label ?? '').slice(0, 40);
    added.push({ secret: r.secret, label, owner: goodId(r.owner) ? r.owner : null });
  }
  if (added.length) await kv.put('rooms', [...have, ...added]);
  done.rooms = added.length;

  for (const id of ids) {
    const epoch = entries.get(`epoch:${id}`);
    if (goodEpoch(epoch)) { // a key epoch only moves forward
      const current = await kv.get(`epoch:${id}`);
      if (!(current?.n >= epoch.n)) await kv.put(`epoch:${id}`, { n: epoch.n, s: epoch.s });
    }
    const [owner, read] = [entries.get(`owner:${id}`), entries.get(`read:${id}`)];
    if (goodId(owner) && (await kv.get(`owner:${id}`)) === undefined) {
      await kv.put(`owner:${id}`, owner);
    }
    if (Number.isSafeInteger(read?.ms) && Number.isSafeInteger(read?.c)
      && (await kv.get(`read:${id}`)) === undefined) {
      await kv.put(`read:${id}`, { ms: read.ms, c: read.c });
    }
  }

  const byRoom = new Map();
  let total = 0;
  for (const [key, env] of snapshot.entries) {
    if (typeof key !== 'string' || !key.startsWith('m:')) continue;
    const [, roomId, ...rest] = key.split(':');
    if (!ids.has(roomId) || !env || rest.join(':') !== env.id) { done.skipped++; continue; }
    if (!byRoom.has(roomId)) byRoom.set(roomId, []);
    byRoom.get(roomId).push([key, env]);
    total++;
  }
  let looked = 0;
  for (const [roomId, list] of byRoom) {
    const held = new Set((await kv.list(`m:${roomId}:`)).map(([key]) => key));
    for (let i = 0; i < list.length; i += 50) {
      await Promise.all(list.slice(i, i + 50).map(async ([key, env]) => {
        if (held.has(key)) return;
        if (!(await verifyEnvelope(env, roomId))) { done.skipped++; return; }
        await kv.put(key, env);
        done.messages++;
      }));
      looked = Math.min(total, looked + 50);
      progress(looked, total);
    }
  }
  return done;
}
