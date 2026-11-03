// History that a device learns from one link must not starve the others: it is passed on in
// batches, not as one frame per message (a receiver's rate limit would drop most of them, and
// live messages behind them).
import test from 'node:test';
import assert from 'node:assert/strict';
import { newRoomSecret } from '../src/crypto/room-keys.js';
import { newIdentity } from './helpers.js';
import { FakeBroker, until } from './fakes.js';
import { link, linkIdentity, makeRoom, stopRooms } from './room-kit.js';

test.afterEach(stopRooms);
const HISTORY = 120; // far more than the 20 frames a link may receive in its first second
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const olds = (room) => room.log.list().filter((e) => e.body?.startsWith?.('old')).length;

test('catching up from the main device reaches all; live messages survive', async () => {
  const secret = newRoomSecret();
  const [main, phone] = [await newIdentity(), await newIdentity()];
  await linkIdentity(main, phone);
  const a = await makeRoom({ secret, name: 'Ada', identity: main });
  const b = await makeRoom({ secret, name: 'Ada', identity: phone });
  const bob = await makeRoom({ secret, name: 'Bob' });
  for (let i = 0; i < HISTORY; i++) await a.sendText(`old ${i}`);
  await link(b, bob);
  const linking = link(a, b); // the phone now learns 300 messages and passes them on to Bob
  const live = [];
  for (let i = 0; i < 10; i++) { live.push(await b.sendText(`live ${i}`)); await wait(50); }
  await linking;
  await until(() => olds(bob) === HISTORY && live.every((e) => bob.log.get(e.id)));
  assert.equal(olds(b), HISTORY);
});

test('a link that is open but not synced does not stop the relay', async () => {
  const broker = new FakeBroker();
  const a = await makeRoom({ name: 'Ada', broker });
  const b = await makeRoom({ secret: a.secret, name: 'Bob', broker });
  a.start(); b.start();
  await until(() => [a, b].every((r) => r.peerList.some((p) => p.state === 'p2p')));
  await until(() => a.members.size && b.members.size);
  for (const entry of a.peers.values()) entry.synced = false; // it carries no chat yet
  const env = await a.sendText('through the brokers');
  await until(() => b.log.get(env.id));
});
