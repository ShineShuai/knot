// A sender learns that a message arrived (confirmed by another member), and a message that
// nobody confirms is sent again through the brokers: a link can look open and carry nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newRoomSecret } from '../src/crypto/room-keys.js';
import { newIdentity } from './helpers.js';
import { DeadLink, FakeBroker, until } from './fakes.js';
import { link, linkIdentity, makeRoom, stopRooms } from './room-kit.js';

test.afterEach(stopRooms);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a message is confirmed by the member who got it', async () => {
  const a = await makeRoom({ name: 'Ada' });
  const b = await makeRoom({ secret: a.secret, name: 'Bob' });
  await link(a, b);
  const env = await a.sendText('hello');
  assert.equal(a.deliveredTo(env.id), 0, 'sent, not yet confirmed');
  await until(() => a.deliveredTo(env.id) === 1);
  assert.equal(b.deliveredTo(env.id), null, 'the receiver does not follow it');
});

test('our own other device does not count as delivery', async () => {
  const secret = newRoomSecret();
  const [main, phone] = [await newIdentity(), await newIdentity()];
  await linkIdentity(main, phone);
  const a = await makeRoom({ secret, name: 'Ada', identity: main });
  const b = await makeRoom({ secret, name: 'Ada', identity: phone });
  await link(a, b);
  const env = await a.sendText('to myself');
  await wait(600);
  assert.equal(a.deliveredTo(env.id), 0);
});

test('over the brokers only, the confirmation comes back the same way', async () => {
  const broker = new FakeBroker();
  const secret = newRoomSecret();
  const a = await makeRoom({ secret, name: 'Ada', broker, linkFactory: () => new DeadLink() });
  const b = await makeRoom({ secret, name: 'Bob', broker, linkFactory: () => new DeadLink() });
  a.start(); b.start();
  await until(() => a.members.size && b.members.size);
  const env = await a.sendText('through the brokers');
  await until(() => a.deliveredTo(env.id) === 1);
});

test('nobody confirms: the message is sent again through the brokers', async () => {
  const broker = new FakeBroker();
  const secret = newRoomSecret();
  const extra = { ackRetryScale: 0.02 }; // 5 s -> 100 ms
  const a = await makeRoom({ secret, name: 'Ada', broker, extra });
  const b = await makeRoom({ secret, name: 'Bob', broker, extra });
  a.start(); b.start();
  const direct = (r) => r.peerList.some((p) => p.state === 'p2p');
  await until(() => direct(a) && direct(b) && a.members.size && b.members.size);
  // a's link to b looks open and carries nothing, the way a dead mobile link does
  for (const entry of a.peers.values()) entry.link.sendChat = () => {};
  const env = await a.sendText('lost on a dead link');
  await until(() => b.log.get(env.id)); // the retry went through the brokers
  await until(() => a.deliveredTo(env.id) === 1);
});

test('alone in the room there is nobody to wait for', async () => {
  const broker = new FakeBroker();
  const a = await makeRoom({ name: 'Ada', broker, extra: { ackRetryScale: 0.02 } });
  a.start();
  const env = await a.sendText('anyone?');
  await wait(400);
  assert.equal(a.deliveredTo(env.id), 0);
});
