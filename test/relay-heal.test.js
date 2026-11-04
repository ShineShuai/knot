// What a direct link does on connecting (history, the member list), over the brokers and after a
// wake-up: the paths a pair behind NATs, or a phone that slept, depends on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newRoomSecret } from '../src/crypto/room-keys.js';
import { newIdentity } from './helpers.js';
import { DeadLink, FakeBroker, until } from './fakes.js';
import { link, makeRoom, stopRooms } from './room-kit.js';

test.afterEach(stopRooms);

test('brokers only: a member who was away gets the messages he missed', async () => {
  const broker = new FakeBroker();
  const secret = newRoomSecret();
  const dead = () => new DeadLink();
  const a = await makeRoom({ secret, name: 'Ada', broker, linkFactory: dead });
  const b = await makeRoom({ secret, name: 'Bob', broker, linkFactory: dead });
  a.start(); // Bob is not here yet
  const sent = [];
  for (let i = 0; i < 5; i++) sent.push(await a.sendText(`while you were away ${i}`));
  b.start();
  await until(() => sent.every((e) => b.log.get(e.id)));
});

test('a link that dropped a message is healed by the next wake-up', async () => {
  const a = await makeRoom({ name: 'Ada' });
  const b = await makeRoom({ secret: a.secret, name: 'Bob' });
  await link(a, b);
  const toB = [...a.peers.values()][0].link;
  const send = toB.sendChat.bind(toB);
  toB.sendChat = () => {}; // the link looks open and carries nothing
  const env = await a.sendText('lost on the way');
  assert.ok(!b.log.get(env.id), 'Bob does not have it');
  toB.sendChat = send;
  b.wake(); // Bob says what he has; Ada gives what he lacks
  await until(() => b.log.get(env.id));
});

test('a direct link answers a question for the member list with the list', async () => {
  const [boss, guest] = [await newIdentity(), await newIdentity()];
  const owner = await makeRoom({ name: 'Boss', identity: boss, owner: boss.id });
  const g = await makeRoom({
    secret: owner.secret, name: 'Gil', identity: guest, owner: boss.id,
  });
  await link(owner, g);
  const frames = [];
  const fromOwner = [...owner.peers.values()][0].link;
  const send = fromOwner.sendChat.bind(fromOwner);
  fromOwner.sendChat = (text) => { frames.push(JSON.parse(text).t); return send(text); };
  const toOwner = [...g.peers.values()][0].link;
  toOwner.sendChat(JSON.stringify({ t: 'admin?', head: 'a-list-we-do-not-share' }));
  await until(() => frames.includes('admin'));
  const before = frames.length;
  // the same list: no answer
  toOwner.sendChat(JSON.stringify({ t: 'admin?', head: owner.roster.head }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(frames.length, before);
});
