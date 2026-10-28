import test from 'node:test';
import assert from 'node:assert/strict';
import { Emitter } from '../src/util/emitter.js';
import { Notifier } from '../src/ui/notifier.js';
import { setLanguage } from '../src/ui/i18n.js';

test.afterEach(() => setLanguage('en'));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setup({ permission = 'granted', enabled = true, active = false, supported = true } = {}) {
  const state = { permission, active, shown: [], asked: 0, opened: [] };
  const env = {
    supported: () => supported,
    permission: () => state.permission,
    request: async () => { state.asked++; state.permission = 'granted'; },
    show: async (title, options, onclick) => { state.shown.push({ title, options, onclick }); },
  };
  const settings = { notifications: enabled };
  const room = Object.assign(new Emitter(), {
    id: 'room1', label: 'Club', log: { textOf: (e) => e.body },
  });
  const notifier = new Notifier({
    settings, env, isActive: () => state.active, open: (id) => state.opened.push(id),
  });
  notifier.watch(room);
  const hear = (name, body, kind = 'text') => room.emit('incoming', { name, body, kind });
  return { state, settings, room, notifier, hear };
}

test('a message in a room that is not on screen becomes one notification', async () => {
  const { state, hear } = setup();
  hear('Bob', 'hello\n  there');
  await wait(450);
  assert.equal(state.shown.length, 1);
  const [note] = state.shown;
  assert.equal(note.title, 'Club');
  assert.equal(note.options.body, 'Bob: hello there');
  assert.equal(note.options.tag, 'room1', 'a newer one replaces the older of its room');
  assert.deepEqual(note.options.data, { room: 'room1' });
  note.onclick();
  assert.deepEqual(state.opened, ['room1']);
});

test('messages that arrive together are summed up; files show their name', async () => {
  const { state, hear } = setup();
  hear('Bob', 'one'); hear('Bob', 'two'); hear('Cy', 'three');
  await wait(450);
  assert.equal(state.shown.length, 1);
  assert.equal(state.shown[0].options.body, '3 new messages');
  hear('Cy', { name: 'photo.png' }, 'file');
  await wait(450);
  assert.equal(state.shown[1].options.body, 'Cy: 📎 photo.png');
});

test('nothing if the room is on screen or opened meanwhile, or off, or refused', async () => {
  const on = setup({ active: true });
  on.hear('Bob', 'hi');
  const late = setup();
  late.hear('Bob', 'hi');
  late.state.active = true; // the user opened the room before the notification was due
  const off = setup({ enabled: false });
  off.hear('Bob', 'hi');
  const denied = setup({ permission: 'denied' });
  denied.hear('Bob', 'hi');
  const unsupported = setup({ supported: false });
  unsupported.hear('Bob', 'hi');
  await wait(450);
  for (const s of [on, late, off, denied, unsupported]) assert.equal(s.state.shown.length, 0);
});

test('permission is asked for only when undecided', async () => {
  const fresh = setup({ permission: 'default' });
  assert.equal(await fresh.notifier.enable(), true);
  assert.equal(fresh.state.asked, 1);
  const granted = setup();
  assert.equal(await granted.notifier.enable(), true);
  assert.equal(granted.state.asked, 0);
  const denied = setup({ permission: 'denied' });
  assert.equal(await denied.notifier.enable(), false);
  assert.equal(denied.state.asked, 0);
  assert.equal(await setup({ supported: false }).notifier.enable(), false);
});
