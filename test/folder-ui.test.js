// The folder part of Settings > Data > Backup, and the bar that asks for permission again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, find } from './fake-dom.js';
import { AppModel } from '../src/app.js';
import { DEFAULTS } from '../src/config.js';
import { backupSecret, collect, open, seal } from '../src/store/backup.js';
import { FOLDER_FILE, FolderBackup, PREVIOUS_FILE } from '../src/store/folder.js';
import { MemoryKV } from '../src/store/kv.js';
import { setLanguage } from '../src/ui/i18n.js';
import { mountUi } from '../src/ui/view.js';
import { newIdentity } from './helpers.js';
import { fakeFolder } from './fake-folder.js';
import { FakeLink, until } from './fakes.js';

const { root: rootA } = installFakeDom();
test.afterEach(() => setLanguage('en'));
const PASS = 'long enough';

/** A person with a room, a folder backup wired to the store, and a fake folder picker. */
async function person({ handle = null, picker = null, supported = true, prepare, ...extra } = {}) {
  const kv = new MemoryKV();
  const folder = new FolderBackup({ kv, delayMs: 20 });
  kv.onWrite = (key) => folder.markDirty(key);
  const settings = { ...DEFAULTS, name: 'Ada', brokersEnabled: false, brokers: [] };
  const model = new AppModel({
    kv, identity: await newIdentity(), settings, iceServers: () => [],
    linkFactory: () => new FakeLink(),
  });
  const room = await model.createRoom('Club');
  await room.sendText('hello');
  await prepare?.({ kv, folder }); // what an earlier visit left
  const root = new rootA.constructor('div');
  const calls = { reloads: 0, picks: 0 };
  const ui = mountUi(root, model, {
    folder, backupIterations: 1000, reload: () => { calls.reloads++; },
    folderEnv: supported ? { showDirectoryPicker() {} } : {},
    pickFolder: picker ?? (async () => { calls.picks++; return handle; }),
    ...extra,
  });
  return { kv, folder, model, room, root, ui, calls };
}
const dataPage = (root) => {
  find(root, 'button', 'Settings')[0].click();
  const dialog = root.querySelector('dialog');
  find(dialog, 'button', 'Data')[0].click();
  return dialog;
};
const type = (el, value) => { el.value = value; };
const passphrase = (dialog, value = PASS) => {
  type(dialog.querySelector('.backup-pass'), value);
  type(dialog.querySelector('.backup-pass2'), value);
};
const choose = (dialog) => find(dialog, 'button', 'Save automatically to a folder')[0].click();
const said = (dialog) => dialog.querySelector('.backup-result').textContent;
const stateLine = (dialog) => dialog.querySelector('.backup-folder-state')?.textContent ?? '';

test('ui: a browser without a folder picker says so and has no folder button', async () => {
  const { root } = await person({ supported: false });
  const dialog = dataPage(root);
  assert.match(dialog.querySelector('.backup-folder').textContent, /cannot write into a folder/);
  assert.equal(find(dialog, 'button', 'Save automatically').length, 0);
  assert.equal(find(dialog, 'button', 'Save backup').length, 1, 'the file backup is still there');
});

test('ui: choosing an empty folder starts saving; stopping leaves the files', async () => {
  const { handle, data } = fakeFolder();
  const { root, folder, calls } = await person({ handle });
  const dialog = dataPage(root);
  passphrase(dialog, 'short');
  choose(dialog);
  await until(() => /at least 8/.test(said(dialog)));
  assert.equal(calls.picks, 0, 'no folder is asked for before the passphrase is right');
  passphrase(dialog);
  choose(dialog);
  await until(() => /Saving to the folder "knot-bak"\. Last saved: /.test(stateLine(dialog)));
  assert.equal(folder.active, true);
  assert.equal(said(dialog), 'Saving to the folder "knot-bak" from now on.');
  const snapshot = await open(data.get(FOLDER_FILE), PASS);
  assert.equal(snapshot.entries.filter(([k]) => k.startsWith('m:')).length >= 1, true);

  find(dialog, 'button', 'Stop saving to the folder')[0].click();
  await until(() => /Stopped/.test(said(dialog)));
  assert.equal(folder.active, false);
  assert.ok(data.has(FOLDER_FILE));
  assert.equal(find(dialog, 'button', 'Save automatically').length, 1);
});

test('ui: the picker closed, or a folder the browser refuses', async () => {
  const closed = await person({ picker: async () => null });
  const dialog = dataPage(closed.root);
  passphrase(dialog);
  choose(dialog);
  const button = () => find(dialog, 'button', 'Save automatically')[0];
  await until(() => button() && !button().disabled && said(dialog) === '');
  assert.equal(closed.folder.active, false);

  const blocked = await person({
    picker: async () => { throw Object.assign(new Error('x'), { name: 'SecurityError' }); },
  });
  const second = dataPage(blocked.root);
  passphrase(second);
  choose(second);
  await until(() => /does not allow this folder/.test(said(second)));
});

test('ui: a folder that holds a backup: replace it, keeping the old file', async () => {
  const old = Uint8Array.of(1, 2, 3, 4);
  const { handle, data } = fakeFolder({ files: { [FOLDER_FILE]: old } });
  const { root, folder } = await person({ handle });
  const dialog = dataPage(root);
  passphrase(dialog);
  choose(dialog);
  const folderText = () => dialog.querySelector('.backup-folder').textContent;
  await until(() => /already holds a knot backup/.test(folderText()));
  assert.equal(folder.active, false, 'nothing is written before the person chooses');
  assert.deepEqual([...data.get(FOLDER_FILE)], [1, 2, 3, 4]);

  find(dialog, 'button', 'Replace it')[0].click();
  await until(() => folder.active && data.get(FOLDER_FILE).length > 100);
  assert.deepEqual([...data.get(PREVIOUS_FILE)], [1, 2, 3, 4]);
  await open(data.get(FOLDER_FILE), PASS);
});

test('ui: a folder that holds a backup: restore it (a wrong passphrase first)', async () => {
  const other = await person({ handle: fakeFolder().handle });
  const file = await seal(await collect(other.kv), await backupSecret(PASS, { iterations: 1000 }));
  const { handle, data } = fakeFolder({ files: { [FOLDER_FILE]: file } });
  const { root, kv, folder, calls } = await person({ handle });
  await kv.delete('rooms'); // a browser that lost its rooms
  const dialog = dataPage(root);
  const text = () => dialog.querySelector('.backup-folder').textContent;
  passphrase(dialog, 'not the passphrase');
  choose(dialog);
  await until(() => /already holds/.test(text()));
  find(dialog, 'button', 'Restore it')[0].click();
  await until(() => /Wrong passphrase/.test(said(dialog)));
  assert.equal(calls.reloads, 0);
  assert.ok(find(dialog, 'button', 'Restore it').length, 'still asking');

  type(dialog.querySelector('.backup-pass'), PASS); // the passphrase typed at the start is kept
  find(dialog, 'button', 'Cancel')[0].click();
  await until(() => !find(dialog, 'button', 'Restore it').length);
  passphrase(dialog);
  choose(dialog);
  await until(() => find(dialog, 'button', 'Restore it').length === 1);
  find(dialog, 'button', 'Restore it')[0].click();
  await until(() => calls.reloads === 1);
  assert.match(said(dialog), /Restored 1 room\(s\)/);
  assert.equal(folder.active, true);
  assert.equal((await kv.get('rooms')).length, 1);
  await open(data.get(FOLDER_FILE), PASS);
});

test('ui: after a restart the browser asks again: a bar, Allow, then it saves', async () => {
  const { handle, data, log } = fakeFolder();
  const { root, folder } = await person({
    handle,
    prepare: async ({ folder: earlier }) => {
      await earlier.enable(handle, await backupSecret(PASS, { iterations: 1000 }));
      handle.permission = 'prompt'; // the browser forgot the permission
      await earlier.load();
    },
  });
  assert.equal(folder.state, 'needs_permission');
  const bar = find(root, 'div', 'Folder backup paused: knot needs your permission');
  assert.equal(bar.length, 1);
  assert.equal(bar[0].hidden, false, 'shown when the page starts, not only on a change');
  const dialog = dataPage(root);
  assert.match(stateLine(dialog), /Paused: the browser wants your permission .* "knot-bak"/);
  const writes = log.writes;

  find(bar[0], 'button', 'Allow')[0].click();
  await until(() => folder.state === 'ok');
  assert.equal(bar[0].hidden, true);
  assert.ok(log.writes > writes);
  assert.ok(data.has(FOLDER_FILE));
});

test('ui: a failing folder shows in the bar with a way to Settings', async () => {
  const { handle } = fakeFolder();
  const { root, folder } = await person({ handle });
  await folder.enable(handle, await backupSecret(PASS, { iterations: 1000 }));
  handle.failWrite = true;
  await folder.saveNow();
  const bar = find(root, 'div', 'Folder backup failed: QuotaExceededError');
  assert.equal(bar.length, 1);
  assert.equal(bar[0].hidden, false);
  find(bar[0], 'button', 'Settings')[0].click();
  assert.ok(root.querySelector('dialog').open);
});
