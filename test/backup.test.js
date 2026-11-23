// The backup file: what goes in, what stays out, the passphrase, and a restore that cannot be
// made to take a forged message, a foreign server or somebody else's room key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AppModel } from '../src/app.js';
import { DEFAULTS } from '../src/config.js';
import { newRoomSecret } from '../src/crypto/room-keys.js';
import { MemoryKV } from '../src/store/kv.js';
import {
  BackupError, backupSecret, collect, countOf, isBackupKey, open, openWith, readHeader, restore,
  seal,
} from '../src/store/backup.js';
import { toB64u } from '../src/util/bytes.js';
import { newIdentity } from './helpers.js';

const settings = { ...DEFAULTS, brokersEnabled: false, brokers: [] };
const FAST = { iterations: 1000 };
const model = async (kv = new MemoryKV(), identity) => {
  const m = new AppModel({
    kv, identity: identity ?? await newIdentity(), settings, iceServers: () => [],
  });
  await m.load();
  return m;
};
const fails = (promise, code) => assert.rejects(
  promise, (e) => e instanceof BackupError && e.code === code,
);

/** A person with an owned room full of every kind of message, and the store behind it. */
async function lived() {
  const kv = new MemoryKV();
  const m = await model(kv);
  const room = await m.createRoom('Club');
  const first = await room.sendText('hello');
  await room.sendText('a reply', room.log.get(first.id));
  await room.editMessage(first.id, 'hello again');
  await room.react(first.id, '👍');
  const doomed = await room.sendText('oops');
  await room.deleteMessage(doomed.id);
  await kv.put('settings', { ...settings, name: 'Ada', language: 'de' });
  return { kv, m, room };
}

test('collect: settings, rooms, keys, messages go in; identity and device state stay', async () => {
  const { kv, room } = await lived();
  const left = ['identity', 'delegate', 'linked', 'sync', 'diag', 'born', 'lost',
    `wait:${room.id}`, `p:${room.id}:x`];
  for (const key of left) await kv.put(key, { secret: true });
  const snapshot = await collect(kv, 5);
  const keys = snapshot.entries.map(([key]) => key);
  assert.ok(keys.every(isBackupKey), keys.join());
  for (const key of ['settings', 'rooms', `owner:${room.id}`, `read:${room.id}`]) {
    assert.ok(keys.includes(key), key);
  }
  assert.ok(keys.filter((k) => k.startsWith('m:')).length >= 4);
  const messages = keys.filter((k) => k.startsWith('m:')).length;
  assert.deepEqual(countOf(snapshot), { rooms: 1, messages });
  assert.doesNotMatch(JSON.stringify(snapshot), /"secret":true/);
});

test('seal and open: the right passphrase opens it; nothing else does', async () => {
  const secret = await backupSecret('correct horse', FAST);
  const content = { format: 'knot-backup', version: 1, entries: [['settings', { a: 1 }]] };
  const bytes = await seal(content, secret);
  assert.deepEqual((await open(bytes, 'correct horse')).entries, [['settings', { a: 1 }]]);
  assert.deepEqual(readHeader(bytes).iterations, 1000);
  await fails(open(bytes, 'wrong horse'), 'wrong_passphrase');
  await fails(open(bytes, ''), 'empty_passphrase');
  const flipped = (at) => Uint8Array.from(bytes, (b, i) => (i === at ? b ^ 1 : b));
  await fails(open(flipped(bytes.length - 1), 'correct horse'), 'wrong_passphrase'); // the data
  await fails(open(flipped(14), 'correct horse'), 'wrong_passphrase'); // the salt, in the header
  const text = new TextEncoder().encode('not a backup at all, just some text');
  await fails(open(text, 'x'), 'not_a_backup');
  await fails(open(bytes.slice(0, 20), 'x'), 'not_a_backup');
  const again = await seal({ format: 'knot-backup', version: 1, entries: [] }, secret);
  assert.notDeepEqual(again.slice(28, 40), bytes.slice(28, 40), 'a fresh IV every time');
  assert.equal((await openWith(again, secret)).entries.length, 0);
});

test('a crafted header cannot make us derive a key for ever; a newer file is named', async () => {
  const secret = await backupSecret('pass phrase', FAST);
  const bytes = await seal({ format: 'knot-backup', version: 1, entries: [] }, secret);
  const huge = Uint8Array.from(bytes);
  huge.set([0xff, 0xff, 0xff, 0xff], 8);
  await fails(open(huge, 'pass phrase'), 'damaged');
  const newer = await seal({ format: 'knot-backup', version: 99, entries: [] }, secret);
  await fails(open(newer, 'pass phrase'), 'newer');
  const odd = await seal({ format: 'something else', version: 1, entries: [] }, secret);
  await fails(open(odd, 'pass phrase'), 'damaged');
});

test('restore into an empty browser: rooms, messages, owner and settings come back', async () => {
  const { kv, room } = await lived();
  const secret = await backupSecret('pass phrase', FAST);
  const file = await seal(await collect(kv), secret);

  const fresh = new MemoryKV(); // a wiped browser, and a new identity
  const done = await restore(fresh, await open(file, 'pass phrase'));
  assert.equal(done.rooms, 1);
  assert.equal(done.skipped, 0);
  assert.ok(done.messages >= 4);
  assert.equal((await fresh.get('settings')).name, 'Ada');

  const m = await model(fresh); // the page reloads
  const again = [...m.rooms.values()][0];
  assert.equal(again.id, room.id);
  assert.equal(again.label, 'Club');
  const texts = again.log.timeline().map((e) => again.log.textOf(e));
  assert.ok(texts.includes('hello again'), texts.join());
  assert.ok(texts.includes('a reply'));
  assert.ok(!texts.includes('oops'), 'a deleted message stays deleted');
  assert.equal(again.isOwner, false, 'the new identity is not the owner: the owner lets it in');
});

test('restore is additive: what is there stays, a key epoch only moves forward', async () => {
  const { kv, room } = await lived();
  const id = room.id;
  await kv.put(`epoch:${id}`, { n: 2, s: toB64u(new Uint8Array(16).fill(2)) });
  const snapshot = await collect(kv);

  const target = new MemoryKV();
  await target.put('rooms', [{ secret: 'AAAAAAAAAAAAAAAAAAAAAA', label: 'Other', owner: null }]);
  await target.put(`epoch:${id}`, { n: 3, s: toB64u(new Uint8Array(16).fill(3)) });
  const done = await restore(target, snapshot);
  assert.equal(done.rooms, 1);
  assert.deepEqual((await target.get('rooms')).map((r) => r.label), ['Other', 'Club']);
  assert.equal((await target.get(`epoch:${id}`)).n, 3, 'the newer epoch here stays');

  const again = await restore(target, snapshot); // twice changes nothing
  assert.deepEqual({ ...again }, { rooms: 0, messages: 0, skipped: 0 });
  await target.put(`epoch:${id}`, { n: 1, s: toB64u(new Uint8Array(16).fill(1)) });
  await restore(target, snapshot);
  assert.equal((await target.get(`epoch:${id}`)).n, 2, 'an older epoch here moves forward');
});

test('restore refuses forged and foreign messages, strays and an identity', async () => {
  const { kv, room } = await lived();
  const snapshot = await collect(kv);
  const at = snapshot.entries.findIndex(([k]) => k.startsWith('m:'));
  const [key, env] = snapshot.entries[at];
  snapshot.entries[at] = [key, { ...env, body: 'forged' }]; // the signature no longer fits
  snapshot.entries.push(['identity', { privateKey: 'x' }], ['delegate', {}],
    [`m:AAAAAAAAAAAAAAAA:${env.id}`, env], // a room that is not in the list
    [`m:${room.id}:other-id`, env]); // a key that does not match the message
  const fresh = new MemoryKV();
  const done = await restore(fresh, snapshot);
  assert.equal(done.skipped, 3);
  assert.equal(await fresh.get('identity'), undefined);
  assert.equal(await fresh.get('delegate'), undefined);
  assert.equal(await fresh.get(key), undefined);
});

test('restore keeps known settings and drops server lists that would not pass', async () => {
  const { kv } = await lived();
  const snapshot = await collect(kv);
  snapshot.entries = snapshot.entries.filter(([k]) => k !== 'settings');
  snapshot.entries.push(['settings', {
    name: 'Eve', language: 'de', imagePreviews: 'off', unknownThing: 1, maxTextLength: 'many',
    brokers: ['ws://evil.test'], turnServers: [{ urls: 'turn:x', username: 'a', credential: 'b' }],
  }]);
  const fresh = new MemoryKV();
  await restore(fresh, snapshot);
  const saved = await fresh.get('settings');
  assert.equal(saved.name, 'Eve');
  assert.equal(saved.imagePreviews, 'off');
  assert.equal('unknownThing' in saved, false);
  assert.equal('maxTextLength' in saved, false, 'a wrong kind of value');
  assert.equal('brokers' in saved, false, 'ws:// is not a broker the app would take');
  assert.equal('turnServers' in saved, false, 'the network lists are dropped together');
});

test('restore: a room with a damaged secret is skipped, the others come back', async () => {
  const snapshot = { entries: [['rooms', [
    { secret: '!!not base64!!', label: 'Bad' }, { secret: toB64u(newRoomSecret()), label: 'Good' },
  ]]] };
  const fresh = new MemoryKV();
  assert.equal((await restore(fresh, snapshot)).rooms, 1);
  assert.deepEqual((await fresh.get('rooms')).map((r) => r.label), ['Good']);
});
