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
  await until(() => a.model.rooms.size === 1, 3000);
  const [room] = [...a.model.rooms.values()];
  rooms.push(room);
  await until(() => room.roster.recoveryKey !== null, 3000);
  const dialog = a.root.querySelector('dialog');
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
  await until(() => b.model.rooms.size === 1, 3000);
  const [recovered] = [...b.model.rooms.values()];
  rooms.push(recovered);
  assert.equal(recovered.recovering, true);
  assert.equal(recovered.isOwner, false); // not until a member shows them the chain
  assert.match(b.root.querySelector('dialog').textContent, /Looking for a member/);
  b.ui.openJoin('knot-rk1-AAAA');
  await until(() => /damaged/.test(b.root.querySelector('dialog').textContent), 3000);
});
