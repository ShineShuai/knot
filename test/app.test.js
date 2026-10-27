// Older and newer data side by side: rooms made before the owner update, rooms made after,
// an older version of the app (or a second tab) writing to the same store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AppModel } from '../src/app.js';
import { DEFAULTS } from '../src/config.js';
import { MemoryKV } from '../src/store/kv.js';
import { newRoomSecret } from '../src/crypto/room-keys.js';
import { newIdentity } from './helpers.js';

const settings = { ...DEFAULTS, brokersEnabled: false, brokers: [] };
const open = async (kv, identity) => {
  const model = new AppModel({ kv, identity, settings, iceServers: () => [] });
  await model.load();
  return model;
};
const byLabel = (model, label) => [...model.rooms.values()].find((r) => r.label === label);
const texts = (room) => room.log.timeline().map((e) => e.body);

test('app: open and owned rooms coexist, keep their messages, and do not mix', async () => {
  const [kv, identity] = [new MemoryKV(), await newIdentity()];
  const first = await open(kv, identity);
  const old = await first.addRoom(newRoomSecret(), 'Old'); // no owner: how rooms used to be
  const owned = await first.createRoom('New');
  await old.sendText('in the old room');
  await owned.sendText('in the new room');
  const again = await open(kv, identity); // a page reload
  assert.equal(again.rooms.size, 2);
  assert.equal(byLabel(again, 'Old').roster, null);
  assert.equal(byLabel(again, 'New').isOwner, true);
  assert.deepEqual(texts(byLabel(again, 'Old')), ['in the old room']);
  assert.deepEqual(texts(byLabel(again, 'New')), ['in the new room']);
  assert.notEqual(byLabel(again, 'Old').id, byLabel(again, 'New').id);
});

test('app: an older version rewriting the room list does not turn an owned room open', async () => {
  const [kv, identity] = [new MemoryKV(), await newIdentity()];
  const first = await open(kv, identity);
  await first.createRoom('Mine');
  // what the version before the owner update saves: secret and label only
  await kv.put('rooms', (await kv.get('rooms')).map(({ secret, label }) => ({ secret, label })));
  const again = await open(kv, identity);
  assert.equal(byLabel(again, 'Mine').isOwner, true);
  assert.equal((await kv.get('rooms'))[0].owner, identity.id); // and the list heals itself
});

test('app: two tabs saving the room list do not lose each other\'s rooms', async () => {
  const [kv, identity] = [new MemoryKV(), await newIdentity()];
  const [tab1, tab2] = [await open(kv, identity), await open(kv, identity)];
  await tab1.createRoom('From tab 1');
  const two = await tab2.createRoom('From tab 2');
  assert.deepEqual((await open(kv, identity)).rooms.size, 2);
  await tab2.removeRoom(two.id);
  const left = await open(kv, identity);
  assert.deepEqual([...left.rooms.values()].map((r) => r.label), ['From tab 1']);
  assert.equal(await kv.get(`owner:${two.id}`), undefined);
});

test('app: leaving a room forgets its owner and its keys', async () => {
  const [kv, identity] = [new MemoryKV(), await newIdentity()];
  const model = await open(kv, identity);
  const room = await model.createRoom('Gone soon');
  await kv.put(`epoch:${room.id}`, { n: 1, s: 'x' });
  await model.removeRoom(room.id);
  assert.equal(await kv.get(`owner:${room.id}`), undefined);
  assert.equal(await kv.get(`epoch:${room.id}`), undefined);
  assert.equal((await kv.get('rooms')).length, 0);
});
