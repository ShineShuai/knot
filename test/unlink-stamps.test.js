// A withdrawn device counts as withdrawn from the stamp of its unlink on, whatever order the
// messages and unlinks arrive in: what it wrote earlier stays, what it wrote later does not,
// and an unlink written by a device that was already withdrawn counts for nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvelope, unlinkBody } from '../src/chat/envelope.js';
import { deriveRoomKeys, newRoomSecret } from '../src/crypto/room-keys.js';
import { toB64u } from '../src/util/bytes.js';
import { HLC } from '../src/util/hlc.js';
import { MemoryKV } from '../src/store/kv.js';
import { newIdentity } from './helpers.js';
import { until } from './fakes.js';
import { link, linkIdentity, makeRoom, stopRooms } from './room-kit.js';

test.afterEach(stopRooms);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const T0 = Date.now() - 600_000;
const clock = (k) => new HLC(() => T0 + k, 0); // a clock stopped k ms after T0
/** `from` sends `env` to the room it is linked with, as a message frame. */
const inject = (from, env) => [...from.peers.values()][0].link.peer.emit(
  'chat', JSON.stringify({ t: 'msg', e: env }),
);

/** Ada's main identity (no certificate: its key cannot be withdrawn) and two linked devices. */
async function ada() {
  const [main, thief, good] = [await newIdentity(), await newIdentity(), await newIdentity()];
  await linkIdentity(main, thief, 'Thief');
  await linkIdentity(main, good, 'Good');
  return { main, thief, good };
}

/** The room that receives, with one other member whose link carries what the test injects. */
async function receiver({ secret = newRoomSecret(), kv = new MemoryKV(), identity } = {}) {
  const room = await makeRoom({
    secret, name: 'Bob', kv, identity, extra: { messagesPerSecond: 1000 }, // injected frames come fast
  });
  const sender = await makeRoom({ secret, name: 'Eve' });
  await link(room, sender);
  await until(() => [...room.peers.values()].every((p) => p.state === 'p2p' && p.synced));
  return { room, secret, kv, sender, put: (env) => inject(sender, env) };
}

/** Ada's devices, one room secret and the envelopes of the story for that room. Made before any
 *  link exists: fake links do not wait for a slow test. */
async function world() {
  const who = await ada();
  const secret = newRoomSecret();
  const e = await story(who, (await deriveRoomKeys(secret)).id);
  return { who, secret, e };
}

/** The envelopes of the story, stamped k ms after T0 (the unlink of `thief` is at 1000). */
async function story({ main, thief, good }, roomId) {
  const text = (who, k, body) => createEnvelope(who, clock(k), roomId, 'text', body, 'Ada');
  const unlink = (who, k, target) => createEnvelope(
    who, clock(k), roomId, 'unlink', unlinkBody(toB64u(target.pub)), 'Ada');
  return {
    before: await text(thief, 500, 'written before the unlink'),
    cut: await unlink(main, 1000, thief), // Ada's original device withdraws the thief's device
    after: await text(thief, 1500, 'written after the unlink'),
    revenge: await unlink(thief, 2000, good), // the withdrawn device tries to withdraw the good one
    fine: await text(good, 3000, 'from the good device'),
  };
}

test('a message written before the unlink counts even when it arrives after it', async () => {
  const { secret, e } = await world();
  const { room, put } = await receiver({ secret });
  put(e.cut);
  await until(() => room.log.get(e.cut.id));
  put(e.before);
  put(e.after);
  await until(() => room.log.get(e.before.id));
  await wait(60);
  assert.ok(room.log.get(e.before.id), 'written at 500, the unlink is at 1000');
  assert.equal(room.log.get(e.after.id), null, 'written at 1500, after it');
  assert.equal(room.dropped['device was unlinked'].n, 1);
});

test('in every arrival order the same envelopes count', async () => {
  const { who, secret, e } = await world();
  const orders = [];
  const permute = (rest, done = []) => {
    if (!rest.length) return orders.push(done);
    rest.forEach((x, i) => permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...done, x]));
    return orders.length;
  };
  permute(['cut', 'after', 'revenge', 'fine']);
  assert.equal(orders.length, 24);
  for (const order of orders) {
    const { room, put } = await receiver({ secret });
    put(e.before);
    for (const name of order) { put(e[name]); await wait(25); }
    await until(() => room.log.get(e.fine.id) && room.log.get(e.cut.id), 3000);
    await until(() => !room.log.get(e.after.id) && !room.log.get(e.revenge.id), 3000);
    const ids = room.log.list().map((x) => x.id).sort();
    assert.deepEqual(ids, [e.before.id, e.cut.id, e.fine.id].sort(), order.join(' > '));
    assert.equal(room.isWithdrawn(who.thief.cert, who.main.id), true);
    assert.equal(room.isWithdrawn(who.good.cert, who.main.id), false, 'its unlink was void');
    room.stop();
  }
});

test('a restart keeps what counts: the thief stays withdrawn, the good device is not', async () => {
  const { who, secret, e } = await world();
  const first = await receiver({ secret });
  first.put(e.revenge); // heard first, so it counts for the moment
  await wait(40);
  first.put(e.cut);
  await until(() => first.room.isWithdrawn(who.thief.cert, who.main.id));
  await until(() => !first.room.log.get(e.revenge.id));
  first.room.stop();
  const { room, put } = await receiver({
    secret: first.secret, kv: first.kv, identity: first.room.identity,
  });
  assert.equal(room.isWithdrawn(who.thief.cert, who.main.id), true);
  assert.equal(room.isWithdrawn(who.good.cert, who.main.id), false);
  put(e.fine);
  put(e.after);
  await until(() => room.log.get(e.fine.id));
  await wait(60);
  assert.equal(room.log.get(e.after.id), null);
});

test('a device withdrawn elsewhere is refused from the moment we hear of it, not before', async () => {
  const { who, secret, e } = await world();
  const { room, put } = await receiver({ secret, identity: who.main });
  const old = e.before;
  put(old);
  await until(() => room.log.get(old.id));
  room.dropDevice(toB64u(who.thief.pub));
  const soon = await createEnvelope(
    who.thief, new HLC(() => Date.now() + 5000, 0), room.id, 'text', 'new', 'Ada');
  put(soon);
  await wait(60);
  assert.ok(room.log.get(old.id), 'what it wrote before stays');
  assert.equal(room.log.get(soon.id), null);
});
