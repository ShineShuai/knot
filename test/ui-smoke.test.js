// Drives the real UI code over a fake DOM: every owner feature must be reachable by buttons.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, find } from './fake-dom.js';
import { AppModel } from '../src/app.js';
import { DEFAULTS } from '../src/config.js';
import { MemoryKV } from '../src/store/kv.js';
import { newRoomSecret } from '../src/crypto/room-keys.js';
import { mountUi } from '../src/ui/view.js';
import { toB64u } from '../src/util/bytes.js';
import { newIdentity } from './helpers.js';
import { FakeBroker, FakeLink, until } from './fakes.js';

const { root: rootA } = installFakeDom();
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

async function person(name, broker) {
  const settings = {
    ...DEFAULTS, name, presenceIntervalMs: 60, connectTimeoutMs: 2000, gatherTimeoutMs: 10,
    adminTimeoutMs: 400, brokersEnabled: !!broker, brokers: broker ? ['wss://fake'] : [],
  };
  const model = new AppModel({
    kv: new MemoryKV(), identity: await newIdentity(), settings, iceServers: () => [],
    WS: broker?.ws(), linkFactory: () => new FakeLink(),
  });
  const root = rootA.constructor === Object ? rootA : new rootA.constructor('div');
  return { model, root, ui: mountUi(root, model) };
}
const button = (root, text) => find(root, 'button', text)[0];
const rooms = [];
test.afterEach(() => { rooms.splice(0).forEach((r) => r.stop()); });

test('ui: a new room is owned, and every owner control is on screen', async () => {
  const a = await person('Ada');
  const room = await a.model.createRoom('Club');
  rooms.push(room);
  a.ui.select(room);
  assert.ok(button(a.root, 'Members'), 'Members button in the room header');
  assert.ok(button(a.root, 'Invite'));
  button(a.root, 'Invite').click();
  await tick();
  const dialog = a.root.querySelector('dialog');
  assert.equal(dialog.open, true);
  assert.match(dialog.textContent, /Join link/);
  const shown = dialog.querySelectorAll('textarea').map((t) => t.value).join(' ');
  assert.match(shown, /#j=/); // the owner's join link
  assert.ok(find(dialog, 'button', 'Create pairing code').length, 'pairing codes: owner only');
  dialog.close();
  button(a.root, 'Members').click();
  assert.match(dialog.textContent, /owner/);
  assert.match(dialog.textContent, /Join requests/);
});

test('ui: an older room without an owner has no owner controls', async () => {
  const a = await person('Ada');
  const room = await a.model.addRoom(newRoomSecret(), 'Old');
  rooms.push(room);
  a.ui.select(room);
  assert.equal(button(a.root, 'Members'), undefined);
  button(a.root, 'Invite').click();
  await tick();
  const shown = a.root.querySelector('dialog').querySelectorAll('textarea').map((t) => t.value);
  assert.match(shown.join(' '), /#r=/);
});

test('ui: join request, greeting, owner approval, then both are in the room', async () => {
  const broker = new FakeBroker();
  const owner = await person('Ada', broker);
  const guest = await person('Bob', broker);
  const room = await owner.model.createRoom('Club');
  rooms.push(room);
  owner.ui.select(room);
  await until(() => room.joinLinkParts);
  const { lobbySecret, ownerId } = await room.joinLinkParts();
  guest.ui.openJoin(`https://knot.test/#j=${toB64u(lobbySecret)}.${ownerId}`);
  const gdialog = guest.root.querySelector('dialog');
  const greeting = gdialog.querySelectorAll('textarea').at(-1); // after the paste box
  assert.ok(greeting, 'greeting box');
  assert.ok(button(gdialog, 'Send request'));
  button(gdialog, 'Send request').click();
  assert.equal(guest.model.rooms.size, 0); // no greeting yet: nothing is sent
  greeting.value = 'Hi, Bob from the club';
  button(gdialog, 'Send request').click();
  await until(() => room.joinRequests.length === 1, 3000);
  assert.match(owner.root.querySelector('.toast').textContent, /Bob asks to join/);
  assert.doesNotMatch(owner.root.textContent, /Bob joined/); // not yet
  assert.equal(room.roster.isMember(guest.model.identity.id), false);
  button(owner.root, 'Members (1)').click();
  const odialog = owner.root.querySelector('dialog');
  assert.match(odialog.textContent, /Hi, Bob from the club/);
  button(odialog, 'Approve').click();
  await until(() => guest.model.rooms.size === 1, 3000);
  const joined = [...guest.model.rooms.values()][0];
  rooms.push(joined);
  assert.equal(joined.ownerId, owner.model.identity.id);
  await until(() => button(guest.root, 'Members'), 3000); // the room opens on screen
  await until(() => /Bob joined/.test(owner.root.textContent), 3000); // a notice, in the log
  for (const { root } of [owner, guest]) assert.doesNotMatch(root.textContent, /\[object Object\]/);
  await until(() => joined.peerList.some((p) => p.state === 'p2p'), 5000);
  button(guest.root, 'Members').click();
  const gm = guest.root.querySelector('dialog');
  assert.equal(find(gm, 'button', 'Remove').length, 0); // owner-only
  assert.equal(find(gm, 'h3', 'Join requests').length, 0);
  button(owner.root, 'Members').click();
  assert.ok(find(odialog, 'button', 'Remove').length >= 1); // the owner may remove Bob
});

test('ui: a new room first shows the recovery code, then the invite', async () => {
  const a = await person('Ada');
  button(a.root, 'New room').click();
  const dialog = a.root.querySelector('dialog');
  button(dialog, 'Create room').click();
  await until(() => a.model.rooms.size === 1, 3000);
  const [room] = [...a.model.rooms.values()];
  rooms.push(room);
  await until(() => room.roster.recoveryKey !== null, 3000);
  await until(() => /Recovery code/.test(dialog.textContent), 3000);
  const shown = dialog.querySelectorAll('textarea').map((t) => t.value).join(' ');
  assert.match(shown, /^knot-rk1-/);
  button(dialog, 'I saved it').click(); // closing it opens the invite
  await until(() => /Join link/.test(dialog.textContent), 3000);
  assert.equal(dialog.open, true);
  button(dialog, 'Close').click();
  button(a.root, 'Members').click();
  assert.ok(find(dialog, 'button', 'New recovery code').length, 'the owner can replace the code');
});

test('ui: pasting a recovery code reopens the room and waits for a member', async () => {
  const a = await person('Ada');
  const room = await a.model.createRoom('Club');
  rooms.push(room);
  const code = await room.newRecoveryCode();
  const b = await person('Ada, new phone');
  b.ui.openJoin(code);
  // The room is listed before the recovery code is armed (an async key derivation in between).
  await until(() => [...b.model.rooms.values()].some((r) => r.recovering), 3000);
  const [recovered] = [...b.model.rooms.values()];
  rooms.push(recovered);
  assert.equal(recovered.isOwner, false); // not until a member shows them the chain
  assert.match(b.root.querySelector('dialog').textContent, /Looking for a member/);
  b.ui.openJoin('knot-rk1-AAAA');
  await until(() => /damaged/.test(b.root.querySelector('dialog').textContent), 3000);
});

test('ui: New room asks for a name first; Cancel or Close creates nothing', async () => {
  const a = await person('Ada');
  button(a.root, 'New room').click();
  const dialog = a.root.querySelector('dialog');
  assert.equal(dialog.open, true);
  assert.equal(dialog.querySelector('input').value, 'Room 1');
  button(dialog, 'Cancel').click();
  assert.equal(dialog.open, false);
  button(a.root, 'New room').click();
  button(dialog, '×').click(); // the corner button is a Cancel too
  await tick();
  assert.equal(a.model.rooms.size, 0, 'nothing is created until Create is pressed');
  button(a.root, 'New room').click();
  dialog.querySelector('input').value = '  Weekend plans  ';
  const create = button(dialog, 'Create room');
  create.click();
  create.click(); // a double click must not make two rooms
  await until(() => a.model.rooms.size === 1, 3000);
  await tick();
  const [room] = [...a.model.rooms.values()];
  rooms.push(room);
  assert.equal(room.label, 'Weekend plans');
  assert.equal(a.model.rooms.size, 1);
});

test('ui: rooms are named, renamed, and never share a default name', async () => {
  const a = await person('Ada');
  const make = async () => {
    button(a.root, 'New room').click();
    const dialog = a.root.querySelector('dialog');
    const name = dialog.querySelector('input').value;
    button(dialog, 'Create room').click();
    await until(() => [...a.model.rooms.values()].some((r) => r.label === name), 3000);
    dialog.close();
    return [...a.model.rooms.values()].find((r) => r.label === name);
  };
  const [one, two] = [await make(), await make()];
  rooms.push(one, two);
  assert.deepEqual([one.label, two.label], ['Room 1', 'Room 2']);
  await a.model.removeRoom(one.id); // leave the first, then create again
  const three = await make();
  rooms.push(three);
  assert.deepEqual([...a.model.rooms.values()].map((r) => r.label).sort(), ['Room 1', 'Room 2']);
  a.ui.select(two);
  button(a.root, '✎').click();
  const dialog = a.root.querySelector('dialog');
  assert.equal(dialog.querySelector('input').value, 'Room 2');
  dialog.querySelector('input').value = 'Book club';
  button(dialog, 'Save').click();
  await until(() => two.label === 'Book club', 3000);
  const title = () => a.root.querySelector('.stage-head')?.querySelector('h2')?.textContent ?? '';
  await until(() => /Book club/.test(title()), 3000);
  assert.match(a.root.textContent, /Book club/); // also in the room list
});

test('ui: every dialog ends with Save and Cancel, or with Close when it changes nothing', async () => {
  const a = await person('Ada');
  const room = await a.model.createRoom('Club');
  rooms.push(room);
  a.ui.select(room);
  const dialog = a.root.querySelector('dialog');
  const footer = () => dialog.querySelector('.dialog-footer').querySelectorAll('button')
    .map((b) => b.textContent);
  const shut = () => { if (dialog.open) dialog.close(); };
  const seen = {};
  const open = async (name, click) => { shut(); click(); await tick(); seen[name] = footer(); };
  await open('new room', () => button(a.root, 'New room').click());
  await open('join', () => button(a.root, 'Join').click());
  await open('invite', () => button(a.root, 'Invite').click());
  await open('members', () => button(a.root, 'Members').click());
  await open('settings', () => button(a.root, 'Settings').click());
  await open('devices', () => { shut(); button(a.root, 'Settings').click(); });
  button(dialog, 'Linked devices').click();
  await tick();
  seen.devices = footer();
  button(a.root, 'Settings').click();
  await tick();
  button(dialog, 'Diagnostics').click();
  await tick();
  seen.diagnostics = footer();
  assert.deepEqual(seen['new room'], ['Create room', 'Cancel']);
  assert.deepEqual(seen.join, ['Join', 'Cancel']);
  assert.deepEqual(seen.invite, ['Close']);
  assert.deepEqual(seen.members, ['Close']);
  assert.deepEqual(seen.settings, ['Save', 'Cancel']);
  assert.deepEqual(seen.devices, ['Save', 'Cancel']);
  assert.deepEqual(seen.diagnostics, ['Close']);
  shut();
});

test('ui: the bar always shows us, also in a room nobody else is in', async () => {
  const a = await person('Ada');
  const room = await a.model.createRoom('Club');
  rooms.push(room);
  a.ui.select(room);
  const entries = a.root.querySelectorAll('li').filter((li) => /peer/.test(li.className));
  assert.deepEqual(entries.map((li) => li.textContent), ['You (offline)']);
  assert.match(entries[0].className, /\bme\b/);
});

test('ui: the ? in the bar explains what the connection types mean', async () => {
  const a = await person('Ada');
  const room = await a.model.createRoom('Club');
  rooms.push(room);
  a.ui.select(room);
  button(a.root, '?').click();
  const dialog = a.root.querySelector('dialog');
  await tick();
  for (const word of ['direct', 'relay', 'seen', 'offline', 'this device', 'You', '@']) {
    assert.ok(dialog.textContent.includes(word), `explains ${word}`);
  }
  assert.match(dialog.textContent, /no server in between/);
  assert.deepEqual(dialog.querySelector('.dialog-footer').querySelectorAll('button')
    .map((b) => b.textContent), ['Close']);
  dialog.close();
});
