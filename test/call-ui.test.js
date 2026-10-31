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
import { FakeAudio, callParty, videoEncoding } from './call-fakes.js';

const { root: rootA } = installFakeDom();
const rooms = [];
test.afterEach(() => { rooms.splice(0).forEach((r) => r.stop()); });

async function person(name, { calls = true, share, speaking } = {}) {
  const settings = {
    ...DEFAULTS, name, brokersEnabled: false, brokers: [], gatherTimeoutMs: 10,
    connectTimeoutMs: 2000, callRetryMs: 20,
  };
  const party = callParty({ share });
  const model = new AppModel({
    kv: new MemoryKV(), identity: await newIdentity(), settings, iceServers: () => [],
    linkFactory: () => new FakeLink(), callEnv: calls ? party.env : undefined,
  });
  const root = new rootA.constructor('div');
  return { model, root, party, ui: mountUi(root, model, { speaking }) };
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

test('ui: text and files during a call: chat beside the video, or a bar under it', async () => {
  const [a, b] = [await person('Ada'), await person('Bob')];
  const [ra, rb] = await pair(a, b);
  a.ui.select(ra);
  b.ui.select(rb);
  const panel = a.root.querySelector('.call');
  const shell = a.root.querySelector('.shell');
  byLabel(a.root, 'Start an audio call').click();
  await until(() => ra.call.joined);
  assert.equal(panel.dataset.mode, 'full');

  // The full-screen call hides the conversation: what arrives is unread, and the button says so.
  await rb.sendText('are you there?');
  await until(() => byLabel(a.root, 'Show chat (1 unread)'));
  assert.equal(ra.unread, 1);
  assert.equal(panel.querySelector('.count').textContent, '1');

  byLabel(a.root, 'Show chat (1 unread)').click();
  assert.equal(panel.dataset.mode, 'chat');
  assert.equal(shell.dataset.call, 'chat');
  assert.equal(panel.hidden, false);
  assert.equal(ra.unread, 0, 'now it is on screen');
  assert.equal(panel.querySelector('.count').hidden, true);

  // Text from the call window's side...
  const box = a.root.querySelector('textarea');
  box.value = 'yes, with you https://example.com/doc';
  box.fire('keydown', { key: 'Enter' });
  const has = (text) => rb.log.timeline().some((e) => rb.log.textOf(e).startsWith(text));
  await until(() => has('yes, with you'));
  // ...and a file, through the same message box.
  const picker = a.root.querySelectorAll('input').find((el) => el.type === 'file');
  picker.files = [new File(['meeting notes'], 'notes.txt', { type: 'text/plain' })];
  picker.fire('change');
  box.fire('keydown', { key: 'Enter' });
  await until(() => rb.log.timeline().some((e) => e.body.name === 'notes.txt'));
  assert.equal(ra.call.joined, true, 'the call goes on');

  // A message that arrives while the chat is beside the call counts as read at once.
  await rb.sendText('got it');
  await until(() => a.root.querySelectorAll('.msg').some((m) => m.textContent.includes('got it')));
  assert.equal(ra.unread, 0);

  byLabel(a.root, 'Minimize').click(); // a bar under the conversation: it stays usable
  assert.equal(panel.dataset.mode, 'mini');
  assert.equal(shell.dataset.call, 'mini');
  byLabel(a.root, 'Expand').click(); // back to what it was
  assert.equal(panel.dataset.mode, 'chat');
  byLabel(a.root, 'Hide chat').click();
  assert.equal(panel.dataset.mode, 'full');
  assert.equal(shell.dataset.call, '');

  find(a.root, 'button', 'Leave call')[0].click();
  assert.equal(panel.hidden, true);
  assert.equal(panel.dataset.mode, 'full');
});

test('ui: the chat button brings up the room of the call, wherever you are', async () => {
  const a = await person('Ada');
  const [r1, r2] = [await a.model.addRoom(newRoomSecret(), 'One'),
    await a.model.addRoom(newRoomSecret(), 'Two')];
  rooms.push(r1, r2);
  a.ui.select(r1);
  byLabel(a.root, 'Start an audio call').click();
  await until(() => r1.call.joined);
  a.ui.select(r2); // reading another room: the call goes on
  assert.match(a.root.querySelector('h2').textContent, /Two/);
  byLabel(a.root, 'Show chat').click();
  assert.match(a.root.querySelector('h2').textContent, /One/);
  assert.equal(a.root.querySelector('.call').dataset.mode, 'chat');
});

test('ui: pause file transfers from the call window; leaving the call ends the pause', async () => {
  const a = await person('Ada');
  const room = await a.model.addRoom(newRoomSecret(), 'Club');
  rooms.push(room);
  a.ui.select(room);
  byLabel(a.root, 'Start an audio call').click();
  await until(() => room.call.joined);
  assert.equal(room.fileTransfer, true);
  assert.equal(byLabel(a.root, 'Pause file transfers').getAttribute('aria-pressed'), 'false');

  byLabel(a.root, 'Pause file transfers').click();
  assert.equal(room.fileTransfer, false);
  assert.equal(byLabel(a.root, 'Allow file transfers').getAttribute('aria-pressed'), 'true');
  byLabel(a.root, 'Attach file').click(); // the message box says why it does not open
  assert.match(a.root.querySelector('.toast').textContent, /paused during the call/);

  byLabel(a.root, 'Allow file transfers').click();
  assert.equal(room.fileTransfer, true);
  byLabel(a.root, 'Pause file transfers').click();
  find(a.root, 'button', 'Leave call')[0].click();
  assert.equal(room.fileTransfer, true, 'files are back when the call is over');
});

test('ui: everyone in the call is shown, camera or not, also in the minimized bar', async () => {
  const [a, b] = [await person('Ada'), await person('Bob')];
  const [ra, rb] = await pair(a, b);
  a.ui.select(ra);
  b.ui.select(rb);
  byLabel(a.root, 'Start an audio call').click(); // Ada: no camera
  await until(() => ra.call.joined);
  b.root.querySelector('.call-banner').querySelectorAll('button')[0].click();
  await until(() => rb.call.joined && a.root.querySelectorAll('.tile').length === 2);

  const grid = a.root.querySelector('.call-grid');
  assert.equal(grid.dataset.count, '2');
  const tiles = a.root.querySelectorAll('.tile');
  assert.ok(tiles.every((tile) => tile.classList.contains('novideo')), 'nobody has a camera');
  const names = tiles.map((tile) => tile.querySelector('.tile-name').textContent);
  assert.deepEqual(names, ['You', 'Bob']);
  assert.ok(tiles.every((tile) => tile.querySelector('.avatar').textContent !== ''));

  byLabel(a.root, 'Minimize').click(); // the video is hidden, the people are not
  assert.equal(a.root.querySelector('.call').dataset.mode, 'mini');
  assert.match(a.root.querySelector('.call-roster').textContent, /^You.*Bob/);
  byLabel(b.root, 'Mute microphone').click();
  await until(() => /Bob 🔇/.test(a.root.querySelector('.call-roster').textContent));
});

test('ui: the person who is speaking is highlighted, and marked in the minimized bar', async () => {
  FakeAudio.loud.clear();
  let ms = 0;
  const ticks = [];
  const speaking = { Context: FakeAudio, now: () => ms, every: (fn) => (ticks.push(fn), () => {}) };
  const a = await person('Ada', { speaking });
  const room = await a.model.addRoom(newRoomSecret(), 'Club');
  rooms.push(room);
  a.ui.select(room);
  byLabel(a.root, 'Start an audio call').click();
  await until(() => room.call.joined);
  const me = () => a.root.querySelector('.self');
  const tick = (at) => { ms = at; ticks.forEach((fn) => fn()); };

  tick(100);
  assert.equal(me().classList.contains('speaking'), false);
  FakeAudio.loud.add(room.call.micStream); // Ada talks
  tick(1000);
  assert.equal(me().classList.contains('speaking'), true);
  byLabel(a.root, 'Minimize').click();
  assert.match(a.root.querySelector('.call-roster').textContent, /You 🔊/);

  FakeAudio.loud.delete(room.call.micStream);
  tick(1200);
  assert.equal(me().classList.contains('speaking'), true, 'held for a moment');
  tick(1600);
  assert.equal(me().classList.contains('speaking'), false);
  assert.doesNotMatch(a.root.querySelector('.call-roster').textContent, /🔊/);

  const ctx = FakeAudio.last;
  find(a.root, 'button', 'Leave call')[0].click();
  assert.equal(ctx.closed, true, 'the audio context goes with the call');
});

/** A ResizeObserver that reports only when a test says so. */
class FakeObserver {
  static all = [];
  elements = new Set();
  constructor(callback) { this.callback = callback; FakeObserver.all.push(this); }
  observe(el) { this.elements.add(el); }
  unobserve(el) { this.elements.delete(el); }
  disconnect() { this.elements.clear(); }
  resize(el, height) { this.callback([{ target: el, contentRect: { height } }]); }
}

test('ui: the call window tells each sender how big its video is shown; paused video is marked',
  async () => {
    globalThis.ResizeObserver = FakeObserver;
    try {
      const [a, b] = [await person('Ada'), await person('Bob')];
      const [ra, rb] = await pair(a, b);
      a.ui.select(ra);
      b.ui.select(rb);
      byLabel(a.root, 'Start a video call').click();
      await until(() => ra.call.joined);
      byLabel(b.root, 'Start an audio call').click();
      await until(() => rb.call.joined && ra.call.participants[0]?.state === 'connected');
      await until(() => a.root.querySelectorAll('.tile').length === 2);

      const bob = a.root.querySelectorAll('.tile')[1]; // Ada's view of Bob
      const watcher = FakeObserver.all.find((o) => o.elements.has(bob));
      assert.ok(watcher, 'remote tiles are watched');
      assert.ok(![...FakeObserver.all].some((o) => o.elements.has(a.root.querySelector('.self'))));

      const encoding = () => videoEncoding(b.party.made[0]).encodings[0]; // Bob sends to Ada
      watcher.resize(bob, 150); // a small tile
      await until(() => encoding().maxBitrate === 100_000);
      watcher.resize(bob, 0); // hidden: the shrink is slow, so nothing changes yet
      assert.equal(encoding().maxBitrate, 100_000);
      watcher.resize(bob, 360); // growing is immediate
      await until(() => encoding().maxBitrate === 500_000);

      // Bob's connection to Ada cannot carry video: Ada's tile for Bob says so.
      await rb.call.setVideo(true);
      await until(() => ra.call.participants[0].v);
      b.party.made[0].stats = [
        { type: 'remote-inbound-rtp', kind: 'video', fractionLost: 0.5, roundTripTime: 0.1 },
      ];
      for (const t of [10_000, 14_000]) { b.party.clock.t = t; await rb.call.adapt(); }
      await until(() => bob.querySelector('.tile-status').textContent.includes('paused'));
      assert.ok(bob.classList.contains('novideo'));
    } finally { delete globalThis.ResizeObserver; }
  });
