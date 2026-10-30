// A linked device's messages and connections carry a device tag ("Ada · phone"), and every
// device of one identity sees that identity's messages as its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './fake-dom.js';
import { authorIdOf } from '../src/chat/envelope.js';
import { newRoomSecret } from '../src/crypto/room-keys.js';
import { Messages } from '../src/ui/messages.js';
import { exportText } from '../src/ui/export.js';
import { peerLabel, withDevice } from '../src/ui/alias.js';
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
  assert.equal(withDevice('Ada', ''), 'Ada · main');
  assert.equal(withDevice('Ada', 'phone'), 'Ada · phone');
  setLanguage('de');
  assert.equal(withDevice('Ada', ''), 'Ada · Haupt');
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
  assert.deepEqual(tags, ['Ada · Pixel', 'Ada · main']);
});

test('every device of Ada shows her messages as its own, tagged with the device', async () => {
  const { a, b, bob } = await trio();
  const [mine, fromPhone] = [await a.sendText('from main'), await b.sendText('from phone')];
  await until(() => [a, b, bob].every((r) => r.log.get(mine.id) && r.log.get(fromPhone.id)));
  for (const room of [a, b]) {
    assert.equal(header(room, mine).startsWith('You · main'), true, 'main message');
    assert.equal(header(room, fromPhone).startsWith('You · Pixel'), true, 'phone message');
  }
  assert.equal(header(bob, mine).startsWith('Ada · main'), true);
  assert.equal(header(bob, fromPhone).startsWith('Ada · Pixel'), true);
  const text = exportText(b);
  assert.ok(text.includes('Ada · Pixel: from phone'), text);
  assert.equal(authorIdOf(fromPhone), authorIdOf(mine));
});
