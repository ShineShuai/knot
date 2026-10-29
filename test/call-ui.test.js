// Drives the real call UI over a fake DOM: the buttons, the banner and the call window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, find } from './fake-dom.js';
import { AppModel } from '../src/app.js';
import { DEFAULTS } from '../src/config.js';
import { decodeCode } from '../src/net/handshake.js';
import { newRoomSecret } from '../src/crypto/room-keys.js';
import { MemoryKV } from '../src/store/kv.js';
import { mountUi } from '../src/ui/view.js';
import { newIdentity } from './helpers.js';
import { FakeLink, until } from './fakes.js';
import { callParty } from './call-fakes.js';

const { root: rootA } = installFakeDom();
const rooms = [];
test.afterEach(() => { rooms.splice(0).forEach((r) => r.stop()); });

async function person(name, { calls = true, share } = {}) {
  const settings = {
    ...DEFAULTS, name, brokersEnabled: false, brokers: [], gatherTimeoutMs: 10,
    connectTimeoutMs: 2000, callRetryMs: 20,
  };
  const model = new AppModel({
    kv: new MemoryKV(), identity: await newIdentity(), settings, iceServers: () => [],
    linkFactory: () => new FakeLink(), callEnv: calls ? callParty({ share }).env : undefined,
  });
  const root = new rootA.constructor('div');
  return { model, root, ui: mountUi(root, model) };
}
const byLabel = (root, label) => root.querySelector(`[aria-label="${label}"]`);

async function pair(a, b) {
  const secret = newRoomSecret();
  const [ra, rb] = [await a.model.addRoom(secret, 'Club'), await b.model.addRoom(secret, 'Club')];
  rooms.push(ra, rb);
  const offer = decodeCode((await ra.createInvite()).code);
  await ra.acceptAnswer(decodeCode((await rb.answerOffer(offer)).code));
  await until(() => [ra, rb].every((r) => r.peerList.some((p) => p.state === 'p2p')));
  return [ra, rb];
}

test('ui: without media support there is no way to start a call', async () => {
  const a = await person('Ada', { calls: false });
  const room = await a.model.addRoom(newRoomSecret(), 'Club');
  rooms.push(room);
  a.ui.select(room);
  assert.equal(byLabel(a.root, 'Start an audio call'), null);
  assert.equal(byLabel(a.root, 'Start a video call'), null);
});

test('ui: start a call, see the banner elsewhere, join, mute, leave', async () => {
  const [a, b] = [await person('Ada'), await person('Bob')];
  const [ra, rb] = await pair(a, b);
  a.ui.select(ra);
  b.ui.select(rb);
  const panelA = a.root.querySelector('.call');
  assert.equal(panelA.hidden, true);

  byLabel(a.root, 'Start an audio call').click(); // Ada starts
  await until(() => ra.call.joined && panelA.hidden === false);
  assert.equal(a.root.querySelectorAll('.tile').length, 1);
  assert.equal(byLabel(a.root, 'Start an audio call'), null); // already in it

  const banner = b.root.querySelector('.call-banner'); // Bob is told
  await until(() => banner.hidden === false);
  assert.match(banner.textContent, /In a call: Ada/);
  banner.querySelectorAll('button')[0].click();
  await until(() => rb.call.joined && ra.call.participants[0]?.state === 'connected');
  await until(() => b.root.querySelectorAll('.tile').length === 2);
  assert.equal(banner.hidden, true); // nothing to announce once we are in

  byLabel(a.root, 'Mute microphone').click();
  await until(() => byLabel(a.root, 'Unmute microphone'));
  const ada = b.root.querySelectorAll('.tile')[1];
  await until(() => ada.querySelector('.tile-status').textContent === '🔇');
  assert.equal(ada.querySelector('.tile-name').textContent, 'Ada');

  byLabel(a.root, 'Turn camera on').click(); // a camera we can use
  await until(() => byLabel(a.root, 'Turn camera off'));
  assert.equal(a.root.querySelector('.self').classList.contains('novideo'), false);

  find(a.root, 'button', 'Leave call')[0].click();
  assert.equal(panelA.hidden, true);
  assert.equal(ra.call.joined, false);
  await until(() => b.root.querySelectorAll('.tile').length === 1);
});

test('ui: starting a call in one room ends the call in another', async () => {
  const a = await person('Ada');
  const [r1, r2] = [await a.model.addRoom(newRoomSecret(), 'One'),
    await a.model.addRoom(newRoomSecret(), 'Two')];
  rooms.push(r1, r2);
  a.ui.select(r1);
  byLabel(a.root, 'Start an audio call').click();
  await until(() => r1.call.joined);
  a.ui.select(r2);
  byLabel(a.root, 'Start an audio call').click();
  await until(() => r2.call.joined);
  assert.equal(r1.call.joined, false);
  assert.equal(a.root.querySelector('.call-title').textContent, 'Two');
});

test('ui: a refused microphone is reported, and the call still opens', async () => {
  const settings = { ...DEFAULTS, name: 'Ada', brokersEnabled: false, brokers: [] };
  const model = new AppModel({
    kv: new MemoryKV(), identity: await newIdentity(), settings, iceServers: () => [],
    callEnv: callParty({ denied: ['audio'] }).env,
  });
  const root = new rootA.constructor('div');
  const ui = mountUi(root, model);
  const room = await model.addRoom(newRoomSecret(), 'Club');
  rooms.push(room);
  ui.select(room);
  byLabel(root, 'Start an audio call').click();
  await until(() => room.call.joined);
  assert.match(root.querySelector('.toast').textContent, /No microphone/);
  assert.equal(root.querySelector('.call').hidden, false);
});

test('ui: share the screen from the call window; phones do not get the button', async () => {
  const a = await person('Ada');
  const room = await a.model.addRoom(newRoomSecret(), 'Club');
  rooms.push(room);
  a.ui.select(room);
  byLabel(a.root, 'Start an audio call').click();
  await until(() => room.call.joined);
  const share = byLabel(a.root, 'Share screen');
  assert.equal(share.hidden, false);
  share.click();
  await until(() => byLabel(a.root, 'Stop sharing'));
  const own = a.root.querySelector('.self');
  assert.ok(own.classList.contains('sharing'));
  assert.ok(!own.classList.contains('novideo'), 'our own screen is shown to us');
  assert.match(own.querySelector('.tile-status').textContent, /🖥/);
  byLabel(a.root, 'Stop sharing').click();
  await until(() => byLabel(a.root, 'Share screen'));
  assert.ok(!own.classList.contains('sharing'));

  const phone = await person('Bob', { share: false });
  const room2 = await phone.model.addRoom(newRoomSecret(), 'Club');
  rooms.push(room2);
  phone.ui.select(room2);
  byLabel(phone.root, 'Start an audio call').click();
  await until(() => room2.call.joined);
  assert.equal(byLabel(phone.root, 'Share screen').hidden, true);
});
