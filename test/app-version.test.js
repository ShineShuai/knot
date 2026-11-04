// Presence says which protocol level an app speaks (src/version.js), so that a room can say
// "their app is older" instead of failing without a word.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../src/config.js';
import { deriveRoomKeys, newRoomSecret } from '../src/crypto/room-keys.js';
import { RoomChannel } from '../src/net/room-channel.js';
import { appLines } from '../src/ui/diagnostics.js';
import { PROTOCOL } from '../src/version.js';
import { newIdentity } from './helpers.js';
import { FakeBroker, until } from './fakes.js';
import { makeRoom, stopRooms } from './room-kit.js';

test.afterEach(stopRooms);

const channel = (keys, identity, broker) => new RoomChannel({
  roomId: keys.id, aes: keys.aes, selfId: identity.id, brokers: ['wss://fake'],
  topicPrefix: DEFAULTS.topicPrefix, WS: broker.ws(),
});

test('presence carries the protocol level and the app version; junk and silence mean level 1',
  async () => {
    const broker = new FakeBroker();
    const keys = await deriveRoomKeys(newRoomSecret());
    const [ida, idb] = [await newIdentity(), await newIdentity()];
    const [a, b] = [channel(keys, ida, broker), channel(keys, idb, broker)];
    const seen = [];
    b.on('presence', (p) => seen.push(p));
    [a, b].forEach((c) => c.start());
    await until(() => a.status.connected === 1 && b.status.connected === 1);
    const cases = [
      [{ pv: PROTOCOL, app: '0.4.0' }, PROTOCOL, '0.4.0'],
      [{}, 1, undefined], // an app from before the announcement
      [{ pv: 'x', app: 'a b' }, 1, undefined],
      [{ pv: -3, app: 'x'.repeat(20) }, 1, undefined],
      [{ pv: 1e9, app: '1.2.3-beta+4' }, 1, '1.2.3-beta+4'],
      [{ pv: 1.5 }, 1, undefined],
      [{ pv: 7 }, 7, undefined],
    ];
    for (const [extra, pv, app] of cases) {
      seen.length = 0;
      await a.announce({ pub: ida.pub, name: 'Ada', ...extra });
      await until(() => seen.length);
      assert.equal(seen[0].pv, pv, JSON.stringify(extra));
      assert.equal(seen[0].app, app, JSON.stringify(extra));
      await new Promise((resolve) => setTimeout(resolve, 5)); // a new IV each time, so no dedup
    }
  });

test('a room tells which members run an older or newer app, and when that changes', async () => {
  const broker = new FakeBroker();
  const secret = newRoomSecret();
  const room = await makeRoom({ secret, name: 'Ada', broker });
  room.start();
  assert.deepEqual(room.appGaps, { older: [], newer: [] });
  const [keys, other] = [await deriveRoomKeys(secret), await newIdentity()];
  const theirs = channel(keys, other, broker);
  theirs.start();
  await until(() => theirs.status.connected === 1);
  let changes = 0;
  room.on('peers', () => changes++);

  await theirs.announce({ pub: other.pub, name: 'Olly' }); // an app from before
  await until(() => room.appGaps.older.length);
  assert.deepEqual(room.appGaps, { older: ['Olly'], newer: [] });
  assert.match(appLines(room).join(), /apps seen: \? p1 \(older\)/);

  const before = changes;
  await theirs.announce({ pub: other.pub, name: 'Olly', pv: PROTOCOL + 1, app: '9.9.9' });
  await until(() => room.appGaps.newer.length);
  assert.deepEqual(room.appGaps, { older: [], newer: ['Olly'] });
  assert.ok(changes > before, 'the room says its peers changed');
  assert.match(appLines(room).join(), /apps seen: 9\.9\.9 p3 \(newer\)/);

  await theirs.announce({ pub: other.pub, name: 'Olly', pv: PROTOCOL, app: '0.4.0' });
  await until(() => room.members.get(other.id).pv === PROTOCOL);
  assert.deepEqual(room.appGaps, { older: [], newer: [] });
  theirs.stop();
});
