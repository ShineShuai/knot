// Devices that write as one identity must not mint the same envelope id in one millisecond:
// each starts its counters in a lane of its own, and a clash that still happens is counted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { counterBase } from '../src/chat/room.js';
import { createEnvelope } from '../src/chat/envelope.js';
import { deriveRoomKeys, newRoomSecret } from '../src/crypto/room-keys.js';
import { HLC } from '../src/util/hlc.js';
import { newIdentity } from './helpers.js';
import { until } from './fakes.js';
import { link, linkIdentity, makeRoom, stopRooms } from './room-kit.js';

test.afterEach(stopRooms);

const withKey = (a, b, cert = {}) => ({ cert, pub: Uint8Array.of(a, b, ...new Array(30).fill(0)) });

test('the main device starts at 0, every other device in a lane taken from its key', () => {
  assert.equal(counterBase({ cert: undefined, pub: Uint8Array.of(7, 7) }), 0);
  assert.equal(counterBase(withKey(0, 0)), 1024, 'the first lane');
  assert.equal(counterBase(withKey(0, 1)), 2048);
  assert.equal(counterBase(withKey(0, 0)), counterBase(withKey(0, 0)), 'the same key, the same lane');
  for (const [a, b] of [[0xff, 0xff], [0x10, 0x20], [0xff, 0x00], [0x00, 0xff]]) {
    const base = counterBase(withKey(a, b));
    assert.ok(base >= 1024 && base <= 4095 * 1024 && base % 1024 === 0, `${a},${b}: ${base}`);
  }
  assert.notEqual(counterBase(withKey(1, 2)), counterBase(withKey(3, 4)));
});

test('a room starts its clock in the lane of its device', async () => {
  const main = await newIdentity();
  const phone = await newIdentity();
  await linkIdentity(main, phone, 'Pixel');
  const secret = newRoomSecret();
  const [a, b] = [await makeRoom({ secret, identity: main }), await makeRoom({ secret, identity: phone })];
  assert.ok(a.hlc.tick().c < 1024, 'the main device');
  const c = b.hlc.tick().c;
  assert.equal(c, counterBase(phone), 'the phone, at the start of its lane');
});

test('two ids that are equal but signed differently are counted, not silently lost', async () => {
  const main = await newIdentity();
  const [one, two] = [await newIdentity(), await newIdentity()];
  await linkIdentity(main, one, 'One');
  await linkIdentity(main, two, 'Two');
  const secret = newRoomSecret();
  const id = (await deriveRoomKeys(secret)).id;
  const T = Date.now() - 5000;
  const stamp = () => new HLC(() => T, 7); // both in the same lane and millisecond
  const [x, y] = [
    await createEnvelope(one, stamp(), id, 'text', 'from one', 'Ada'),
    await createEnvelope(two, stamp(), id, 'text', 'from two', 'Ada'),
  ];
  assert.equal(x.id, y.id, 'the same id');
  const room = await makeRoom({ secret, name: 'Bob', extra: { messagesPerSecond: 1000 } });
  const sender = await makeRoom({ secret, name: 'Eve' });
  await link(room, sender);
  await until(() => [...room.peers.values()].every((p) => p.state === 'p2p' && p.synced));
  const put = (env) => [...sender.peers.values()][0].link.peer.emit(
    'chat', JSON.stringify({ t: 'msg', e: env }));
  put(x);
  await until(() => room.log.get(x.id));
  put(y);
  await until(() => room.dropped['id clash']);
  assert.equal(room.dropped['id clash'].n, 1);
  assert.equal(room.log.get(x.id).body, 'from one', 'the first one stays');
  put(x); // the same envelope again is an ordinary repeat, not a clash
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(room.dropped['id clash'].n, 1);
});
