// Settings > Data > Backup and the empty room list's way to it, over the fake DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, find } from './fake-dom.js';
import { AppModel } from '../src/app.js';
import { DEFAULTS } from '../src/config.js';
import { MemoryKV } from '../src/store/kv.js';
import { setLanguage } from '../src/ui/i18n.js';
import { mountUi } from '../src/ui/view.js';
import { newIdentity } from './helpers.js';
import { FakeLink, until } from './fakes.js';

const { root: rootA } = installFakeDom();
test.afterEach(() => setLanguage('en'));

async function person(opts) {
  const settings = { ...DEFAULTS, name: 'Ada', brokersEnabled: false, brokers: [] };
  const model = new AppModel({
    kv: new MemoryKV(), identity: await newIdentity(), settings, iceServers: () => [],
    linkFactory: () => new FakeLink(),
  });
  const root = new rootA.constructor('div');
  const ui = mountUi(root, model, { backupIterations: 1000, ...opts });
  return { model, root, ui };
}
const dataPage = (root) => {
  find(root, 'button', 'Settings')[0].click();
  const dialog = root.querySelector('dialog');
  find(dialog, 'button', 'Data')[0].click();
  return dialog;
};
const type = (el, value) => { el.value = value; };

test('ui: a backup needs a long passphrase, typed twice, and something to save', async () => {
  const saved = [];
  const { model, root } = await person({ saveFile: (name, bytes) => saved.push({ name, bytes }) });
  const dialog = dataPage(root);
  const say = () => dialog.querySelector('.backup-result').textContent;
  const save = () => find(dialog, 'button', 'Save backup')[0].click();

  type(dialog.querySelector('.backup-pass'), 'short');
  save();
  await until(() => /at least 8/.test(say()));
  type(dialog.querySelector('.backup-pass'), 'long enough');
  type(dialog.querySelector('.backup-pass2'), 'long enough!');
  save();
  await until(() => /differ/.test(say()));
  type(dialog.querySelector('.backup-pass2'), 'long enough');
  save();
  await until(() => /no rooms/.test(say()));
  assert.equal(saved.length, 0);

  const room = await model.createRoom('Club');
  await room.sendText('hello');
  save();
  const named = /^Saved knot-backup-\d{4}-\d\d-\d\d\.knotbk with 1 room\(s\) and 1 message/;
  await until(() => named.test(say()));
  assert.equal(saved.length, 1);
  assert.match(saved[0].name, /\.knotbk$/);
  assert.equal(dialog.querySelector('.backup-pass').value, '', 'not kept on the page');
  assert.ok(saved[0].bytes.length > 100);
  room.stop();
});

test('ui: restoring asks for the right passphrase, then loads the page again', async () => {
  const saved = [];
  const a = await person({ saveFile: (name, bytes) => saved.push(bytes) });
  const room = await a.model.createRoom('Club');
  await room.sendText('hello');
  const first = dataPage(a.root);
  type(first.querySelector('.backup-pass'), 'long enough');
  type(first.querySelector('.backup-pass2'), 'long enough');
  find(first, 'button', 'Save backup')[0].click();
  await until(() => saved.length === 1);
  room.stop();

  let reloaded = 0;
  const b = await person({ reload: () => { reloaded++; } });
  const dialog = dataPage(b.root);
  const say = () => dialog.querySelector('.backup-result').textContent;
  const restore = () => find(dialog, 'button', 'Restore backup')[0].click();
  restore();
  await until(() => /Choose a backup file/.test(say()));
  dialog.querySelector('.backup-file').files = [new Blob([saved[0]])];
  type(dialog.querySelector('.backup-restore-pass'), 'not the one');
  restore();
  await until(() => /Wrong passphrase/.test(say()));
  assert.equal(reloaded, 0);
  type(dialog.querySelector('.backup-restore-pass'), 'long enough');
  restore();
  await until(() => reloaded === 1);
  assert.match(say(), /Restored 1 room\(s\) and 1 message\(s\); 0 skipped/);
  assert.equal((await b.model.kv.get('rooms')).length, 1);
  assert.equal(find(dialog, 'button', 'Restore backup')[0].disabled, false);
});

test('ui: not a backup file, and the empty room list offers the way to restore', async () => {
  const { root } = await person();
  const open = find(root, 'button', 'Restore a backup');
  assert.equal(open.length, 1, 'the empty room list has it');
  open[0].click();
  const dialog = root.querySelector('dialog');
  assert.ok(dialog.open);
  assert.ok(dialog.querySelector('.backup-file'), 'and it lands on the Data page');
  dialog.querySelector('.backup-file').files = [new Blob(['just some text, not a backup file'])];
  type(dialog.querySelector('.backup-restore-pass'), 'whatever');
  find(dialog, 'button', 'Restore backup')[0].click();
  const say = () => dialog.querySelector('.backup-result').textContent;
  await until(() => /not a knot backup file/.test(say()));
});
