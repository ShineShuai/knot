// What is new since the user last looked at a room, per device.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AppModel } from '../src/app.js';
import { DEFAULTS } from '../src/config.js';
import { MemoryKV } from '../src/store/kv.js';
import { newRoomSecret } from '../src/crypto/room-keys.js';
import { newIdentity } from './helpers.js';
import { until } from './fakes.js';
import { link, makeRoom, pairRooms, stopRooms } from './room-kit.js';

test.afterEach(stopRooms);

test('only others\' messages count until looked at; reactions and edits never do', async () => {
  const [a, b] = await pairRooms();
  const heard = [];
  a.on('incoming', (env) => heard.push(env.body));
  assert.equal(a.unread, 0);
  await a.sendText('mine');
  await b.sendText('one');
  const two = await b.sendText('two');
  await until(() => a.unread === 2);
  assert.deepEqual(heard, ['one', 'two']);
  await b.react(two.id, '👍');
  await b.editMessage(two.id, 'two!');
  await a.react(two.id, '👍');
  await until(() => a.log.isEdited(two));
  assert.equal(a.unread, 2);
  let changes = 0;
  a.on('unread', () => changes++);
  await a.markRead();
  assert.equal(a.unread, 0);
  assert.equal(changes, 1);
  await a.markRead(); // nothing new: no event
  assert.equal(changes, 1);
  await b.sendText('three');
  await until(() => a.unread === 1);
});

test('the mark survives a reload; history from before this feature counts as read', async () => {
  const kv = new MemoryKV();
  const identity = await newIdentity();
  const secret = newRoomSecret();
  const a = await makeRoom({ secret, kv, identity });
  const b = await makeRoom({ secret, name: 'Bob' });
  await link(a, b);
  await b.sendText('one');
  await b.sendText('two');
  await until(() => a.unread === 2);
  a.stop();
  const again = await makeRoom({ secret, kv, identity });
  assert.equal(again.unread, 2, 'unread stays unread across a reload');
  await again.markRead();
  const third = await makeRoom({ secret, kv, identity });
  assert.equal(third.unread, 0);

  await kv.delete(`read:${third.id}`); // a device from before unread counts existed
  const old = await makeRoom({ secret, kv, identity });
  assert.equal(old.log.list().length, 2);
  assert.equal(old.unread, 0, 'the whole old history is not "new"');
});

test('leaving a room forgets its mark', async () => {
  const kv = new MemoryKV();
  const settings = { ...DEFAULTS, brokersEnabled: false, brokers: [] };
  const model = new AppModel({
    kv, identity: await newIdentity(), settings, iceServers: () => [],
  });
  const room = await model.addRoom(newRoomSecret(), 'Club');
  assert.ok(await kv.get(`read:${room.id}`));
  await model.removeRoom(room.id);
  assert.equal(await kv.get(`read:${room.id}`), undefined);
});
