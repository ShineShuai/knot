// The folder backup: written once for a burst of changes, never empty over full, asks again
// when the browser wants a click, and tells when it cannot write.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newRoomSecret } from '../src/crypto/room-keys.js';
import { backupSecret, open } from '../src/store/backup.js';
import {
  FOLDER_FILE, FolderBackup, PREVIOUS_FILE, canPickFolder, keepPrevious, pickFolder, readBackup,
} from '../src/store/folder.js';
import { IdbKV, MemoryKV } from '../src/store/kv.js';
import { toB64u } from '../src/util/bytes.js';
import { fakeFolder, fakeIndexedDb } from './fake-folder.js';
import { until } from './fakes.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const secret = () => backupSecret('pass phrase', { iterations: 1000 });
const withRoom = async (kv = new MemoryKV()) => {
  await kv.put('rooms', [{ secret: toB64u(newRoomSecret()), label: 'Club', owner: null }]);
  return kv;
};
/** A folder backup wired to its store as main.js does. */
async function backup({ kv = null, ...options } = {}) {
  const store = kv ?? await withRoom();
  const folder = new FolderBackup({ kv: store, delayMs: 30, ...options });
  store.onWrite = (key) => folder.markDirty(key);
  return { kv: store, folder, ...fakeFolder() };
}

test('enable saves at once: an encrypted file the passphrase opens', async () => {
  const { kv, folder, handle, data } = await backup();
  const states = [];
  folder.on('state', (s) => states.push(s));
  await folder.enable(handle, await secret());
  assert.equal(folder.state, 'ok');
  assert.equal(folder.name, 'knot-bak');
  assert.ok(folder.savedAt > 0);
  const snapshot = await open(data.get(FOLDER_FILE), 'pass phrase');
  assert.deepEqual(snapshot.entries.map(([k]) => k), ['rooms']);
  assert.ok((await kv.get('folder')).handle, 'kept for the next visit');
  assert.deepEqual(states, ['ok'], 'off to ok once; the save itself is no news');
});

test('a burst of changes is written once; what is not part of a backup is ignored', async () => {
  const { kv, folder, handle, log } = await backup();
  await folder.enable(handle, await secret());
  assert.equal(log.writes, 1);
  const others = ['diag', 'born', 'lost', 'sync', 'p:r:x', 'folder', 'identity'];
  for (const key of others) await kv.put(key, 1);
  await wait(80);
  assert.equal(log.writes, 1, 'nothing worth a write changed');
  await kv.put('settings', { name: 'Ada' });
  await kv.put('m:r:1', {});
  await kv.put('settings', { name: 'Eva' });
  await wait(15);
  assert.equal(log.writes, 1, 'not yet: changes wait a moment');
  await until(() => log.writes === 2);
  await wait(80);
  assert.equal(log.writes, 2, 'one write for the three changes');
});

test('flush writes now, only if something changed', async () => {
  const { kv, folder, handle, log } = await backup({ delayMs: 60_000 });
  await folder.enable(handle, await secret());
  await folder.flush();
  assert.equal(log.writes, 1);
  await kv.put('read:r', { ms: 1, c: 0 });
  await folder.flush();
  assert.equal(log.writes, 2);
});

test('a browser that asks again: paused, no writes, until the person allows', async () => {
  const { kv, folder, handle, log } = await backup();
  await folder.enable(handle, await secret());
  const states = [];
  folder.on('state', (s) => states.push(s));
  handle.permission = 'prompt'; // after a restart
  const again = new FolderBackup({ kv, delayMs: 20 });
  again.on('state', (s) => states.push(`again ${s}`));
  await again.load();
  assert.equal(again.state, 'needs_permission');
  kv.onWrite = (key) => again.markDirty(key);
  await kv.put('settings', {});
  await again.flush();
  assert.equal(log.writes, 1, 'nothing written without permission');
  handle.answer = 'denied';
  assert.equal(await again.allow(), false);
  assert.equal(again.state, 'needs_permission');
  assert.equal(again.error, 'permission refused');
  handle.answer = 'granted';
  assert.equal(await again.allow(), true);
  assert.equal(again.state, 'ok');
  assert.equal(log.writes, 2, 'the change that waited is written');
  assert.ok(states.every((s) => s.startsWith('again')));
});

test('never writes an empty browser over a backup', async () => {
  const kv = new MemoryKV(); // no rooms: a browser that lost its data
  const { folder, handle, log, data } = await backup({ kv });
  data.set(FOLDER_FILE, Uint8Array.of(1, 2, 3));
  await folder.enable(handle, await secret());
  assert.equal(log.writes, 0);
  assert.deepEqual([...data.get(FOLDER_FILE)], [1, 2, 3]);
  assert.equal(folder.state, 'ok');
});

test('a failed write leaves the old file whole, says why, and tries again later', async () => {
  const { kv, folder, handle, log, data } = await backup();
  await folder.enable(handle, await secret());
  const before = Uint8Array.from(data.get(FOLDER_FILE));
  handle.failWrite = true;
  const states = [];
  folder.on('state', (s) => states.push(s));
  await kv.put('settings', {});
  await folder.flush();
  assert.equal(folder.state, 'error');
  assert.equal(folder.error, 'QuotaExceededError');
  assert.equal(log.aborts, 1);
  assert.deepEqual([...data.get(FOLDER_FILE)], [...before]);
  handle.failWrite = false;
  await kv.put('settings', { name: 'x' });
  await folder.flush();
  assert.equal(folder.state, 'ok');
  assert.deepEqual(states, ['error', 'ok']);
});

test('the folder of an earlier visit comes back; stopping forgets it, not the files', async () => {
  const { kv, folder, handle, data } = await backup();
  await folder.enable(handle, await secret());
  const next = new FolderBackup({ kv, delayMs: 20 });
  await next.load();
  assert.equal(next.active, true);
  assert.equal(next.name, 'knot-bak');
  assert.equal(next.state, 'ok');
  await next.disable();
  assert.equal(next.active, false);
  assert.equal(next.state, 'off');
  assert.equal(await kv.get('folder'), undefined);
  assert.ok(data.has(FOLDER_FILE));
  await next.flush();
  assert.equal(new FolderBackup({ kv }).active, false);
});

test('readBackup and keepPrevious', async () => {
  const { handle, data } = fakeFolder();
  assert.equal(await readBackup(handle), null);
  data.set(FOLDER_FILE, Uint8Array.of(9, 8, 7));
  assert.deepEqual([...await readBackup(handle)], [9, 8, 7]);
  await keepPrevious(handle, Uint8Array.of(9, 8, 7));
  assert.deepEqual([...data.get(PREVIOUS_FILE)], [9, 8, 7]);
});

test('the folder picker: only some browsers have it; closing it is not an error', async () => {
  assert.equal(canPickFolder({}), false);
  assert.equal(canPickFolder({ showDirectoryPicker() {} }), true);
  const asked = [];
  const picker = async (options) => { asked.push(options); return 'h'; };
  const picked = await pickFolder({ showDirectoryPicker: picker });
  assert.equal(picked, 'h');
  assert.equal(asked[0].mode, 'readwrite');
  const refuse = (name) => async () => { throw Object.assign(new Error(name), { name }); };
  assert.equal(await pickFolder({ showDirectoryPicker: refuse('AbortError') }), null);
  const blocked = pickFolder({ showDirectoryPicker: refuse('SecurityError') });
  await assert.rejects(blocked, /SecurityError/);
});

test('the store tells what was written; a watcher that fails never fails a write', async () => {
  const kv = new MemoryKV();
  const seen = [];
  kv.onWrite = (key) => seen.push(key);
  await kv.put('a', 1);
  await kv.delete('a');
  assert.deepEqual(seen, ['a', 'a']);

  const fake = fakeIndexedDb();
  globalThis.indexedDB = fake.indexedDB;
  try {
    const idb = new IdbKV('t');
    const keys = [];
    idb.onWrite = (key) => { keys.push(key); throw new Error('watcher broke'); };
    await idb.put('k', 1);
    assert.equal(await idb.get('k'), 1);
    await idb.delete('k');
    assert.equal(await idb.get('k'), undefined);
    assert.deepEqual(keys, ['k', 'k']);
  } finally { delete globalThis.indexedDB; }
});
