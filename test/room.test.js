import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/chat/room.js';
import { DEFAULTS } from '../src/config.js';
import { decodeCode } from '../src/net/handshake.js';
import { newRoomSecret } from '../src/crypto/room-keys.js';
import { MemoryKV } from '../src/store/kv.js';
import { newIdentity } from './helpers.js';
import { DeadLink, FakeBroker, FakeLink, until } from './fakes.js';

const rooms = [];
async function makeRoom(
  {
    secret = newRoomSecret(),
    name,
    broker,
    linkFactory = () => new FakeLink(),
    kv = new MemoryKV(),
    identity,
  } = {},
) {
  const settings = {
    ...DEFAULTS, name, presenceIntervalMs: 60, connectTimeoutMs: 2000, gatherTimeoutMs: 10,
    brokersEnabled: !!broker, brokers: broker ? ['wss://fake'] : [],
  };
  const room = await Room.open({
    identity: identity ?? (
      await newIdentity()
    ), secret, label: name, kv, settings, linkFactory, WS: broker?.ws(),
    iceServers: () => [],
  });
  rooms.push(room);
  return room;
}
test.afterEach(() => { rooms.splice(0).forEach((r) => r.stop()); });

const texts = (room) => room.log.list().map((e) => e.body);
const p2p = (room) => room.peerList.filter((p) => p.state === 'p2p').length;

/** Full manual pairing between two rooms; returns [roomA, roomB]. */
async function pairManually(opts = {}) {
  const a = await makeRoom({ name: 'Ada', ...opts.a });
  const invite = await a.createInvite();
  const offer = decodeCode(invite.code);
  const b = await makeRoom({ name: 'Bob', secret: offer.roomSecret, ...opts.b });
  const reply = await b.answerOffer(offer);
  await a.acceptAnswer(decodeCode(reply.code));
  await until(() => p2p(a) === 1 && p2p(b) === 1);
  return [a, b, reply.sas];
}

test('manual pairing connects two devices and shares one room', async () => {
  const [a, b, sas] = await pairManually();
  assert.equal(a.id, b.id);
  assert.equal(a.peerList[0].sas, sas);
  assert.equal(b.peerList[0].sas, sas);
  await a.sendText('hello bob');
  await b.sendText('hi ada');
  await until(() => texts(a).length === 2 && texts(b).length === 2);
  assert.deepEqual(texts(a), texts(b));
});

test('an invite code cannot be answered twice, and replies need a matching invite', async () => {
  const a = await makeRoom({ name: 'Ada' });
  const offer = decodeCode((await a.createInvite()).code);
  const b = await makeRoom({ secret: offer.roomSecret, name: 'Bob' });
  const c = await makeRoom({ secret: offer.roomSecret, name: 'Cy' });
  const reply = await b.answerOffer(offer);
  await assert.rejects(b.answerOffer(offer), /already used/);
  const other = await makeRoom({ name: 'Eve' });
  await assert.rejects(other.acceptAnswer(decodeCode(reply.code)), /No open invite/);
  await a.acceptAnswer(decodeCode(reply.code));
  await assert.rejects(a.acceptAnswer(decodeCode(reply.code)), /No open invite/);
  void c;
});

test('a new link syncs history both ways', async () => {
  const a = await makeRoom({ name: 'Ada' });
  for (const t of ['one', 'two', 'three']) await a.sendText(t);
  const offer = decodeCode((await a.createInvite()).code);
  const b = await makeRoom({ secret: offer.roomSecret, name: 'Bob' });
  await b.sendText('from bob');
  await a.acceptAnswer(decodeCode((await b.answerOffer(offer)).code));
  await until(() => texts(a).length === 4 && texts(b).length === 4);
  assert.deepEqual(texts(a), texts(b));
});

test('forged and foreign messages are ignored', async () => {
  const [a, b] = await pairManually();
  const other = await makeRoom({ name: 'Mallory' }); // different room secret
  const stray = await other.sendText('wrong room');
  const link = [...a.peers.values()][0].link;
  link.peer.emit('chat', JSON.stringify({ t: 'msg', e: stray }));       // foreign room
  link.peer.emit('chat', 'not json');
  const good = await a.sendText('real');
  link.peer.emit(
    'chat',
    JSON.stringify({ t: 'msg', e: { ...good, id: good.id + 'x', body: 'tampered' } }),
  );
  await until(() => texts(b).includes('real'));
  assert.deepEqual(texts(b), ['real']);
});

test('brokers connect peers automatically; the smaller peer id dials', async () => {
  const broker = new FakeBroker();
  const secret = newRoomSecret();
  const [a, b, c] = await Promise.all(
    ['A', 'B', 'C'].map((name) => makeRoom({ name, secret, broker })),
  );
  [a, b, c].forEach((r) => r.start());
  await until(() => [a, b, c].every((r) => p2p(r) === 2), 5000);
  await a.sendText('hello everyone');
  await until(() => [b, c].every((r) => texts(r).includes('hello everyone')));
});

test('text falls back to the broker relay when P2P cannot connect', async () => {
  const broker = new FakeBroker();
  const secret = newRoomSecret();
  const [a, b] = await Promise.all(
    ['A', 'B'].map(
      (name) => makeRoom({ name, secret, broker, linkFactory: () => new DeadLink() }),
    ),
  );
  [a, b].forEach((r) => r.start());
  await until(() => a.members.size === 1 && b.members.size === 1);
  assert.equal(p2p(a), 0);
  await a.sendText('via relay');
  await until(() => texts(b).includes('via relay'));
  assert.ok(b.peerList.some((p) => p.state === 'relay'));
});

test('messages persist across restarts and respect the FIFO cap', async () => {
  const kv = new MemoryKV();
  const identity = await newIdentity();
  const secret = newRoomSecret();
  const a = await makeRoom({ name: 'Ada', secret, kv, identity });
  a.log = new (a.log.constructor)(3); // tiny cap
  for (const t of ['1', '2', '3', '4', '5']) await a.sendText(t);
  assert.deepEqual(texts(a), ['3', '4', '5']);
  const again = await makeRoom({ name: 'Ada', secret, kv, identity });
  assert.deepEqual(texts(again), ['3', '4', '5']);
});

test('files transfer peer-to-peer and are checked against the announced hash', async () => {
  const [a, b] = await pairManually();
  const data = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 31) % 256);
  const env = await a.shareFile(
    new File([data], 'blob.bin', { type: 'application/octet-stream' }),
  );
  await until(() => b.log.has(env.id));
  const progress = [];
  const blob = await b.downloadFile(
    b.log.list().find((e) => e.kind === 'file'),
    (got, total) => progress.push([got, total]),
  );
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), data);
  assert.deepEqual(progress.at(-1), [70_000, 70_000]);
  assert.equal(await a.downloadFile(env), a.files.local(env.body.id)); // sender's own copy

  FakeLink.corruptFiles = true;
  await assert.rejects(b.downloadFile(env), /Checksum mismatch/);
  FakeLink.corruptFiles = false;
});

test('downloading from a disconnected sender fails clearly', async () => {
  const [a, b] = await pairManually();
  const env = await a.shareFile(new File(['hi'], 'hi.txt'));
  await until(() => b.log.has(env.id));
  [...a.peers.values()][0].link.close();
  await until(() => p2p(b) === 0);
  await assert.rejects(b.downloadFile(env), /not connected/);
});
