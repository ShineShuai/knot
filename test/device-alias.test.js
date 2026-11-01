// A linked device's messages and connections carry a device tag ("Ada @ phone"), and every
// device of one identity sees that identity's messages as its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './fake-dom.js';
import { authorIdOf } from '../src/chat/envelope.js';
import { newRoomSecret } from '../src/crypto/room-keys.js';
import { Messages } from '../src/ui/messages.js';
import { exportText } from '../src/ui/export.js';
import { peerEntries, peerLabel, withDevice } from '../src/ui/alias.js';
import { setLanguage } from '../src/ui/i18n.js';
import { newIdentity } from './helpers.js';
import { until } from './fakes.js';
import { link, linkIdentity, makeRoom, stopRooms } from './room-kit.js';

installFakeDom();
test.afterEach(() => { stopRooms(); setLanguage('en'); });

/** Ada's main device `a`, her linked phone `b` ("Pixel"), and Bob, in one open room. */
async function trio() {
  const secret = newRoomSecret();
  const [main, phone] = [await newIdentity(), await newIdentity()];
  await linkIdentity(main, phone);
  const [a, b] = [
    await makeRoom({ secret, name: 'Ada', identity: main }),
    await makeRoom({ secret, name: 'Ada', identity: phone }),
  ];
  const bob = await makeRoom({ secret, name: 'Bob' });
  await link(a, bob);
  await link(b, bob);
  return { a, b, bob, main, phone };
}

const header = (room, env) => new Messages({ images: { forget() {} }, composer: {} })
  .render(room, env, () => {}).querySelectorAll('div')[0].textContent;

test('withDevice: plain name for one device, "main" for the one without a certificate', () => {
  assert.equal(withDevice('Ada', null), 'Ada');
  assert.equal(withDevice('Ada', ''), 'Ada @ main');
  assert.equal(withDevice('Ada', 'phone'), 'Ada @ phone');
  setLanguage('de');
  assert.equal(withDevice('Ada', ''), 'Ada @ Haupt');
});

test('a person with one device has no tag; the first certificate seen adds tags', async () => {
  const [bob, carol] = [await makeRoom({ name: 'Bob' }), await makeRoom({ name: 'Carol' })];
  assert.equal(bob.deviceOf(carol.identity.member), null);
  const { a, b, bob: watcher, main } = await trio();
  await until(() => watcher.deviceOf(main.id) === ''); // her phone introduced itself
  assert.equal(watcher.deviceOf(main.id, b.identity.cert.n), 'Pixel');
  assert.equal(b.peerDevice(b.identity.id), 'Pixel');
  assert.equal(watcher.deviceOf(watcher.identity.member), null);
  assert.equal(a.deviceOf(main.id), null, 'the main device has not met the phone yet');
  await b.sendText('from my phone');
  await until(() => a.deviceOf(main.id) === '');
  assert.equal(a.peerDevice(a.identity.id), '');
});

test('the connection list tells the devices apart', async () => {
  const { bob } = await trio();
  await until(() => bob.peerList.filter((p) => p.device !== null).length === 2);
  const tags = bob.peerList.map((p) => peerLabel(bob, p.id)).sort();
  assert.deepEqual(tags, ['Ada @ Pixel', 'Ada @ main']);
});

test('every device of Ada shows her messages as its own, tagged with the device', async () => {
  const { a, b, bob } = await trio();
  const [mine, fromPhone] = [await a.sendText('from main'), await b.sendText('from phone')];
  await until(() => [a, b, bob].every((r) => r.log.get(mine.id) && r.log.get(fromPhone.id)));
  for (const room of [a, b]) {
    assert.equal(header(room, mine).startsWith('You @ main'), true, 'main message');
    assert.equal(header(room, fromPhone).startsWith('You @ Pixel'), true, 'phone message');
  }
  assert.equal(header(bob, mine).startsWith('Ada @ main'), true);
  assert.equal(header(bob, fromPhone).startsWith('Ada @ Pixel'), true);
  const text = exportText(b);
  assert.ok(text.includes('Ada @ Pixel: from phone'), text);
  assert.equal(authorIdOf(fromPhone), authorIdOf(mine));
});

test('the connection bar has one entry per person, with their devices and connections', () => {
  const row = (member, name, device, state, sas = null) => ({ member, name, device, state, sas });
  const entries = peerEntries([
    row('A', 'Ada', '', 'relay', '111 222'), row('B', 'Bob', null, 'p2p', '333 444'),
    row('A', 'Ada', 'mac', 'p2p', '555 666'), row('C', 'Cy', null, 'seen'),
  ]);
  assert.deepEqual(entries.map((e) => e.text), [
    'Ada @ main (relay) | mac (direct)', 'Bob (direct)', 'Cy (seen)',
  ]);
  assert.deepEqual(entries.map((e) => e.state), ['p2p', 'p2p', 'seen'], 'the best connection');
  assert.deepEqual(entries[0].parts, [
    { text: 'main (relay)', state: 'relay' }, { text: 'mac (direct)', state: 'p2p' },
  ], 'each device in the colour of its own connection');
  assert.ok(entries[0].title.includes('main: ') && entries[0].title.includes('555 666'));
  assert.ok(entries[1].title.includes('333 444') && !entries[1].title.includes('main'));
  assert.equal(entries[2].title, '');
  assert.deepEqual(peerEntries([row('A', 'Ada', 'mac', 'p2p')]).map((e) => e.text), [
    'Ada @ mac (direct)',
  ]);
});

test('we are "You" in the bar, always, with or without other devices', () => {
  const me = (device, state = 'relay') => ({
    member: 'A', name: 'Ada', device, state, sas: null, mine: true, self: true,
  });
  const peer = (device, state, name = 'Ada') => ({
    member: 'A', name, device, state, sas: null, mine: true,
  });
  const alone = peerEntries([{ member: 'B', name: 'Bob', device: null, state: 'p2p' }],
    { ...me(null, 'p2p') });
  assert.deepEqual(alone.map((e) => e.text), ['You (direct)', 'Bob (direct)'], 'we come first');
  assert.deepEqual(alone.map((e) => e.mine), [true, false]);
  const linked = peerEntries([peer('mac', 'p2p'), peer('pixel', 'relay', 'Ada B')], me(''));
  assert.deepEqual(linked.map((e) => e.text), [
    'You @ main (this device, relay) | mac (direct) | pixel (relay)',
  ], 'always "You", whatever the devices call us');
  assert.deepEqual(linked[0].parts.map((p) => p.state), ['relay', 'p2p', 'relay']);
  assert.equal(peerEntries([], me(null, 'relay'))[0].text, 'You (relay)');
  assert.equal(peerEntries([], me(null, 'offline'))[0].text, 'You (offline)');
  assert.equal(peerEntries([], me('', 'offline'))[0].text, 'You @ main (this device, offline)');
  // only our other devices are known (no row of our own): still "You"
  assert.equal(peerEntries([peer('mac', 'p2p')]).map((e) => e.text)[0], 'You @ mac (direct)');
});

test('each entry carries the meaning of its connection types', () => {
  const [you, bob] = peerEntries(
    [{ member: 'B', name: 'Bob', device: null, state: 'relay' }],
    { member: 'A', name: 'Ada', device: null, state: 'p2p', mine: true, self: true },
  );
  assert.match(you.help, /^You: the best way this device reaches the room/);
  assert.match(you.help, /direct: A direct link between the two devices/);
  assert.match(bob.help, /^relay: No direct link: messages are passed on through the brokers/);
  assert.ok(!bob.help.includes('You:'));
});

test('our own row for the bar names the device once we have several', async () => {
  const { a, b, bob } = await trio();
  assert.equal(a.selfRow.name, 'Ada');
  assert.equal(a.selfRow.state, 'p2p', 'a direct link to Bob');
  assert.equal(bob.selfRow.device, null, 'Bob has one device');
  await b.sendText('from my phone');
  await until(() => a.selfRow.device === '');
  assert.equal(a.selfRow.device, '', 'the main device');
  assert.equal(b.selfRow.device, 'Pixel');
  const mine = peerEntries(a.peerList, a.selfRow).find((e) => e.mine);
  assert.match(mine.text, /^You @ main \(this device, \w+\)/);
});
