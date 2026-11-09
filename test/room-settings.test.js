// The room settings over the fake DOM, and what is behind them: a person's own choices for a
// room (mute, image previews) that are kept, reach their other devices and nobody else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, find } from './fake-dom.js';
import { AppModel } from '../src/app.js';
import { DEFAULTS } from '../src/config.js';
import { DeviceSync, prefKey } from '../src/chat/device-sync.js';
import { MemoryKV } from '../src/store/kv.js';
import { newRoomSecret } from '../src/crypto/room-keys.js';
import { setLanguage } from '../src/ui/i18n.js';
import { mountUi } from '../src/ui/view.js';
import { newIdentity } from './helpers.js';
import { FakeLink, until } from './fakes.js';

const { root: rootA } = installFakeDom();
const models = [];
test.afterEach(() => {
  models.splice(0).forEach((m) => m.stop());
  setLanguage('en');
});

const settings = () => ({ ...DEFAULTS, name: 'Ada', brokersEnabled: false, brokers: [] });
async function openModel(kv, identity) {
  const model = new AppModel({
    kv, identity, settings: settings(), iceServers: () => [], linkFactory: () => new FakeLink(),
  });
  await model.load();
  models.push(model);
  return model;
}

/** A person with one room on screen and its settings open. */
async function inRoom({ owned = true, kv = new MemoryKV(), identity = null } = {}) {
  const model = await openModel(kv, identity ?? await newIdentity());
  const room = owned ? await model.createRoom('Club') : await model.addRoom(newRoomSecret(), 'Old');
  const root = new rootA.constructor('div');
  const ui = mountUi(root, model);
  ui.select(room);
  root.querySelector('[aria-label="Room settings"]').click();
  const dialog = root.querySelector('dialog');
  const page = (name) => find(dialog, 'button', name)[0].click();
  const toggle = (label) => find(dialog, 'label', label)[0].querySelector('input');
  return { model, room, root, ui, dialog, page, toggle };
}

const pause = () => new Promise((r) => setTimeout(r, 15));

test('room settings: pages of an owned room, and who is who on the Overview', async () => {
  const { dialog, room } = await inRoom();
  assert.equal(dialog.querySelector('h2').textContent, 'Room settings: Club');
  assert.deepEqual(dialog.querySelector('nav').querySelectorAll('button').map((b) => b.textContent),
    ['Overview', 'Members', 'Rules', 'My preferences', 'Leave room']);
  assert.equal(dialog.querySelector('.chip').textContent, 'Name: only you');
  assert.deepEqual(dialog.querySelectorAll('dd').map((d) => d.textContent),
    ['Owner (you)', 'You', '1']);
  assert.equal(room.isOwner, true);
});

test('room settings: a room without an owner says so and has no member page', async () => {
  const { dialog } = await inRoom({ owned: false });
  assert.deepEqual(dialog.querySelector('nav').querySelectorAll('button').map((b) => b.textContent),
    ['Overview', 'My preferences', 'Leave room']);
  assert.deepEqual(dialog.querySelectorAll('dd').map((d) => d.textContent),
    ['Open room, no owner']);
});

test('room settings: our own name applies at once and on screen; empty takes it back', async () => {
  const { dialog, room, root, model } = await inRoom();
  const name = dialog.querySelector('input');
  assert.equal(name.placeholder, 'Club', 'the name we would see without our own');
  name.value = 'Book club';
  name.fire('change');
  await until(() => room.title === 'Book club');
  const title = () => root.querySelector('.stage-head').querySelector('h2').textContent;
  await until(() => /Book club/.test(title()));
  assert.equal(room.label, 'Club', 'the first name stays');
  assert.deepEqual(model.roomPrefs(room.id), { name: 'Book club' });
  name.value = '   ';
  name.fire('change');
  await until(() => room.title === 'Club');
  await until(() => /Club/.test(title()));
  assert.deepEqual(model.roomPrefs(room.id), {}, 'nothing left to keep');
});

test('room settings: mute is kept, marked in the list, and survives a reload', async () => {
  const [kv, identity] = [new MemoryKV(), await newIdentity()];
  const { dialog, page, toggle, room, root, model } = await inRoom({ kv, identity });
  page('My preferences');
  assert.equal(dialog.querySelector('.chip').textContent, 'Only you');
  const mute = toggle('Mute this room');
  assert.equal(room.muted, false);
  mute.checked = true;
  mute.fire('change');
  await until(() => room.muted);
  assert.deepEqual(model.roomPrefs(room.id), { mute: true });
  assert.ok(root.querySelector('.muted-mark'), 'a mark in the room list');
  const again = await openModel(kv, identity);
  assert.equal([...again.rooms.values()][0].muted, true);
  mute.checked = false;
  mute.fire('change');
  await until(() => !room.muted);
  assert.deepEqual(model.roomPrefs(room.id), {}, 'nothing left to keep');
  assert.equal(model.sync.value(prefKey(room.id)), null);
});

test('room settings: previews here override the app setting; inheriting follows it', async () => {
  const { dialog, page, room, model } = await inRoom();
  page('My preferences');
  const select = dialog.querySelector('select');
  assert.deepEqual(select.querySelectorAll('option').map((o) => o.textContent),
    ['Use the app setting (Load automatically)', 'Load automatically', 'Load on tap',
      'Off (files only)']);
  select.value = 'tap';
  select.fire('change');
  await until(() => room.previewMode === 'tap');
  assert.equal(model.settings.imagePreviews, 'auto', 'the app setting is not touched');
  select.value = 'inherit';
  select.fire('change');
  await until(() => room.previewMode === 'auto');
  await model.updateSettings({ imagePreviews: 'off' });
  assert.equal(room.previewMode, 'off');
});

test('room settings: leaving removes the room and what was chosen for it', async () => {
  const { dialog, page, toggle, room, model, ui } = await inRoom();
  page('My preferences');
  toggle('Mute this room').checked = true;
  toggle('Mute this room').fire('change');
  await until(() => room.muted);
  const ask = globalThis.confirm;
  globalThis.confirm = () => true;
  try {
    page('Leave room');
    find(dialog, 'button', 'Leave room').at(-1).click();
    await until(() => model.rooms.size === 0);
  } finally { globalThis.confirm = ask; }
  assert.equal(dialog.open, false, 'the settings of a room that is gone are closed');
  assert.equal(ui.current, null);
  assert.equal(model.sync.value(prefKey(room.id)), null);
});

test('room choices: only these keys and values; one item per room', async () => {
  const id = 'A'.repeat(16);
  const sync = new DeviceSync({ kv: new MemoryKV(), settings: { ...DEFAULTS }, deviceId: 'd1' });
  await sync.load();
  const sent = await sync.set({ [prefKey(id)]: { mute: true, previews: 'tap' } });
  assert.deepEqual(sent[prefKey(id)].v, { mute: true, previews: 'tap' });
  for (const bad of [{ mute: false }, { previews: 'x' }, { other: 1 }, [], 'mute']) {
    await assert.rejects(sync.set({ [prefKey(id)]: bad }), /invalid/);
  }
  const other = new DeviceSync({ kv: new MemoryKV(), settings: { ...DEFAULTS }, deviceId: 'd2' });
  await other.load();
  const forged = { ...sent, [prefKey('B'.repeat(16))]: { v: { mute: 1 }, ms: 1, c: 0, by: 'd1' } };
  const taken = await other.merge(forged);
  assert.deepEqual(Object.keys(taken), [prefKey(id)], 'the odd one is left out');
  assert.deepEqual(other.value(prefKey(id)), { mute: true, previews: 'tap' });
});

test('room choices: another device of ours changes them, and this one follows', async () => {
  const model = await openModel(new MemoryKV(), await newIdentity());
  const room = await model.createRoom('Club');
  const heard = [];
  model.on('prefs', (r) => heard.push(r));
  const phone = new DeviceSync({
    kv: new MemoryKV(), settings: { ...DEFAULTS }, deviceId: 'phone',
  });
  await phone.load();
  const items = await phone.set({ [prefKey(room.id)]: { mute: true } });
  await model.sync.merge(items);
  await model.setRoomPrefs(room.id, { previews: 'off' }); // keeps the other choice
  assert.deepEqual(model.roomPrefs(room.id), { mute: true, previews: 'off' });
  assert.equal(room.muted, true);
  assert.equal(heard.length, 1);
});

test('room settings: the Rules page names online members whose app is older', async () => {
  const { dialog, page, room } = await inRoom();
  page('Rules');
  assert.equal(find(dialog, 'p', 'Online with an older app').length, 0);
  Object.defineProperty(room, 'appGaps', { get: () => ({ older: ['Bob', 'Cy'], newer: [] }) });
  find(dialog, 'button', 'Revert')[0].click(); // the page is drawn again
  assert.match(dialog.textContent, /older app, so they may not follow these rules: Bob, Cy\./);
});

test('room settings: the count beside Members follows the people waiting', async () => {
  const { dialog, room } = await inRoom();
  const members = () => find(dialog, 'button', 'Members')[0];
  assert.equal(members().textContent, 'Members', 'nobody waits: no count');
  let waiting = 2;
  Object.defineProperty(room, 'joinRequests', { get: () => Array(waiting).fill({}) });
  room.emit('requests');
  assert.equal(members().textContent, 'Members2');
  waiting = 0;
  room.emit('requests');
  assert.equal(members().textContent, 'Members');
  assert.equal(members().querySelector('.count').hidden, true);
  dialog.close();
  waiting = 3;
  room.emit('requests'); // closed: nothing follows any more
  assert.equal(members().textContent, 'Members');
});

test('room choices: our own name for a room is bounded, and empty is not a name', async () => {
  const id = 'A'.repeat(16);
  const sync = new DeviceSync({ kv: new MemoryKV(), settings: { ...DEFAULTS }, deviceId: 'd1' });
  await sync.load();
  await sync.set({ [prefKey(id)]: { name: 'Book club', mute: true } });
  assert.deepEqual(sync.value(prefKey(id)), { name: 'Book club', mute: true });
  for (const bad of [{ name: '' }, { name: 'x'.repeat(41) }, { name: 7 }]) {
    await assert.rejects(sync.set({ [prefKey(id)]: bad }), /invalid/, JSON.stringify(bad));
  }
});

test('room settings: the owner sets a name, the largest file and the delete rule', async () => {
  const { dialog, page, room, root } = await inRoom();
  page('Rules');
  const fields = () => dialog.querySelectorAll('input').filter((i) => i.type === 'text');
  const size = dialog.querySelector('select');
  assert.deepEqual(size.querySelectorAll('option').map((o) => o.textContent),
    ['No limit of the room', '1 MB', '5 MB', '25 MB', '100 MB']);
  assert.equal(dialog.querySelector('.apply').hidden, true);
  fields()[0].value = 'Team Alpha';
  fields()[0].fire('input');
  size.value = '5';
  size.fire('change');
  const del = find(dialog, 'label', 'Owner can delete others')[0].querySelector('input');
  del.checked = false;
  del.fire('change');
  assert.equal(dialog.querySelector('.apply').hidden, false);
  find(dialog, 'button', 'Publish rules')[0].click();
  await until(() => room.rules.name === 'Team Alpha' && room.rules.maxFileMb === 5);
  assert.equal(room.rules.ownerDelete, false);
  const title = () => root.querySelector('.stage-head').querySelector('h2').textContent;
  await until(() => /Team Alpha/.test(title()));
  assert.equal(room.label, 'Club');
});
