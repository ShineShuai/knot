import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/chat/room.js';
import { JoinRequest } from '../src/chat/join.js';
import { lobbySecretOf } from '../src/chat/lobby.js';
import { decodeRecoveryCode } from '../src/chat/recovery.js';
import { FileTransfer } from '../src/files/transfer.js';
import { DEFAULTS } from '../src/config.js';
import { decodeCode } from '../src/net/handshake.js';
import { newRoomSecret } from '../src/crypto/room-keys.js';
import { MemoryKV } from '../src/store/kv.js';
import { toB64u } from '../src/util/bytes.js';
import { newIdentity } from './helpers.js';
import { png } from './images.js';
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
    derive,
    owner = null,
    extra = {},
  } = {},
) {
  const settings = {
    ...DEFAULTS, name, presenceIntervalMs: 60, connectTimeoutMs: 2000, gatherTimeoutMs: 10,
    brokersEnabled: !!broker, brokers: broker ? ['wss://fake'] : [], adminTimeoutMs: 400,
    ...extra,
  };
  const room = await Room.open({
    identity: identity ?? (
      await newIdentity()
    ), secret, label: name, owner, kv, settings, linkFactory, WS: broker?.ws(),
    iceServers: () => [], derive,
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

// ---- image previews ------------------------------------------------------------------------

const THUMB = png(160, 107);
const PREVIEW = png(1280, 853, { extra: 6000 });
const deriveBig = async (file) => (
  file.type.startsWith('image/')
    ? {
      img: { w: 3000, h: 2000, t: toB64u(THUMB), tm: 'image/png' },
      preview: new Blob([PREVIEW], { type: 'image/png' }),
    }
    : null
);
const photo = () => new File([new Uint8Array(500_000).fill(3)], 'photo.png', { type: 'image/png' });
const fileEnv = (room) => room.log.list().find((e) => e.kind === 'file');
const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());

test('image preview: thumbnail inline, preview fetched, original never', async () => {
  const [a, b] = await pairManually({ a: { derive: deriveBig } });
  const link = [...a.peers.values()][0].link;
  const served = [];
  const send = link.sendFile.bind(link);
  link.sendFile = (data) => {
    if (typeof data === 'string' && JSON.parse(data).t === 'meta') served.push(JSON.parse(data).id);
    return send(data);
  };
  const env = await a.shareFile(photo());
  await until(() => fileEnv(b));
  const got = fileEnv(b);
  assert.equal(got.body.img.t, toB64u(THUMB)); // arrived inside the message itself
  const blob = await b.previewBlob(got);
  assert.equal(blob.type, 'image/png');
  assert.deepEqual(await bytesOf(blob), PREVIEW);
  assert.deepEqual(served, [got.body.img.p.id]); // 500 KB original was not requested
  assert.notEqual(got.body.img.p.id, env.body.id);
  link.close(); // sender gone: the cached copy still works
  await until(() => p2p(b) === 0);
  assert.deepEqual(await bytesOf(await b.previewBlob(got)), PREVIEW);
  assert.equal((await a.previewBlob(env)).size, PREVIEW.length); // sender sees its own too
});

test('image preview: a corrupted transfer is rejected and not cached', async () => {
  const [a, b] = await pairManually({ a: { derive: deriveBig } });
  await a.shareFile(photo());
  await until(() => fileEnv(b));
  const got = fileEnv(b);
  FakeLink.corruptFiles = true;
  try { await assert.rejects(b.previewBlob(got), /Checksum mismatch/); } finally {
    FakeLink.corruptFiles = false;
  }
  assert.equal(await b.previews.blob(got.body.img.p.id), null);
  assert.deepEqual(await bytesOf(await b.previewBlob(got)), PREVIEW); // a retry works
});

test('image preview: without any link and cache the error says so', async () => {
  const [a, b] = await pairManually({ a: { derive: deriveBig } });
  await a.shareFile(photo());
  await until(() => fileEnv(b));
  [...b.peers.values()][0].link.close();
  await until(() => p2p(b) === 0);
  await assert.rejects(b.previewBlob(fileEnv(b)), /not connected/);
});

test('image preview: another peer serves a cached preview when the author is away', async () => {
  const [a, b] = await pairManually({ a: { derive: deriveBig } });
  await a.shareFile(photo());
  await until(() => fileEnv(b));
  await b.previewBlob(fileEnv(b)); // b now holds the verified preview
  const offer = decodeCode((await b.createInvite()).code);
  const c = await makeRoom({ name: 'Cy', secret: offer.roomSecret });
  await b.acceptAnswer(decodeCode((await c.answerOffer(offer)).code));
  await until(() => p2p(c) === 1 && fileEnv(c));
  [...a.peers.values()][0].link.close();
  assert.equal(c.peerList.some((p) => p.id === a.identity.id && p.state === 'p2p'), false);
  assert.deepEqual(await bytesOf(await c.previewBlob(fileEnv(c))), PREVIEW);
});

test('image preview: a small original is its own preview and carries no second copy', async () => {
  const small = png(300, 200, { extra: 5000 });
  const derive = async () => ({
    img: { w: 300, h: 200, t: toB64u(THUMB), tm: 'image/png' },
    preview: null,
  });
  const [a, b] = await pairManually({ a: { derive } });
  await a.shareFile(new File([small], 's.png', { type: 'image/png' }));
  await until(() => fileEnv(b));
  const got = fileEnv(b);
  assert.equal(got.body.img.p, undefined);
  assert.deepEqual(await bytesOf(await b.previewBlob(got)), small);
});

test('image preview: the sender keeps its own preview across a restart', async () => {
  const [kv, identity, secret] = [new MemoryKV(), await newIdentity(), newRoomSecret()];
  const a = await makeRoom({ name: 'Ada', secret, kv, identity, derive: deriveBig });
  await a.shareFile(photo());
  a.stop();
  const again = await makeRoom({ name: 'Ada', secret, kv, identity, derive: deriveBig });
  assert.deepEqual(await bytesOf(await again.previewBlob(fileEnv(again))), PREVIEW);
  await again.previews.clear();
  await assert.rejects(again.previewBlob(fileEnv(again)), /not connected/);
});

test('files without img are unchanged and have no preview', async () => {
  const [a, b] = await pairManually({ a: { derive: deriveBig } });
  const note = new File(['hello'], 'note.txt', { type: 'text/plain' });
  const env = await a.shareFile(note);
  assert.equal(env.body.img, undefined);
  await until(() => fileEnv(b));
  assert.equal(await b.previewBlob(fileEnv(b)), null);
});

test('a peer cannot make us serve more than a few transfers at once', async () => {
  const files = new FileTransfer();
  const body = await files.share(new File([new Uint8Array(50_000)], 'x.bin'));
  const sent = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const link = {
    sendFile: async (data) => {
      sent.push(data);
      if (typeof data === 'string' && JSON.parse(data).t === 'meta') await gate;
    },
  };
  for (let i = 0; i < 8; i++) files.onFrame(link, JSON.stringify({ t: 'get', id: body.id }));
  const busy = () => sent.filter((d) => typeof d === 'string' && d.includes('"busy"')).length;
  await until(() => busy() === 2);
  release();
  await until(() => sent.filter((d) => typeof d === 'string' && d.includes('"end"')).length === 6);
});

// ---- delete, quote, connection info -------------------------------------------------------

const timeline = (room) => room.log.timeline();
const stored = async (kv) => (await kv.list('m:')).map(([, env]) => env);

test('delete: everyone drops the content and sees who deleted it', async () => {
  const kv = new MemoryKV();
  const [a, b] = await pairManually({ b: { kv } });
  const keep = await a.sendText('keep me');
  const oops = await a.sendText('oops, wrong chat');
  await until(() => b.log.has(oops.id));
  await a.deleteMessage(oops.id);
  await until(() => b.log.isGone(oops.id));
  for (const room of [a, b]) {
    const items = timeline(room);
    assert.deepEqual(items.map((e) => e.kind), ['text', 'gone']);
    assert.equal(items[0].id, keep.id);
    assert.equal(items[1].name, 'Ada'); // shown: who deleted it
    assert.equal(items[1].by, a.identity.id);
  }
  assert.equal((await stored(kv)).some((e) => e.body === 'oops, wrong chat'), false);
  assert.equal(await a.deleteMessage(oops.id), null); // already gone: nothing to do
});

test('delete: own messages only; survives restart and reaches late joiners', async () => {
  const [kv, identity, secret] = [new MemoryKV(), await newIdentity(), newRoomSecret()];
  const a = await makeRoom({ name: 'Ada', secret, kv, identity });
  const offer = decodeCode((await a.createInvite()).code);
  const b = await makeRoom({ name: 'Bob', secret });
  await a.acceptAnswer(decodeCode((await b.answerOffer(offer)).code));
  await until(() => p2p(a) === 1 && p2p(b) === 1);
  const mine = await a.sendText('secret plan');
  await until(() => b.log.has(mine.id));
  await assert.rejects(b.deleteMessage(mine.id), /only delete your own/);
  await a.deleteMessage(mine.id);
  await until(() => b.log.isGone(mine.id));
  const again = await makeRoom({ name: 'Ada', secret, kv, identity }); // restart
  assert.deepEqual(timeline(again).map((e) => e.kind), ['gone']);
  const invite = decodeCode((await b.createInvite()).code);
  const c = await makeRoom({ name: 'Cy', secret: invite.roomSecret });
  await b.acceptAnswer(decodeCode((await c.answerOffer(invite)).code));
  await until(() => c.log.isGone(mine.id));
  assert.deepEqual(timeline(c).map((e) => e.kind), ['gone']);
  assert.equal(JSON.stringify(c.log.list()).includes('secret plan'), false);
});

test('delete: a deleted image is no longer offered and its preview is purged', async () => {
  const [a, b] = await pairManually({ a: { derive: deriveBig } });
  const env = await a.shareFile(photo());
  await until(() => fileEnv(b));
  await b.previewBlob(fileEnv(b));
  const [original, preview] = [env.body.id, env.body.img.p.id];
  assert.ok(await b.previews.blob(preview));
  assert.ok(a.files.local(original));
  await a.deleteMessage(env.id);
  await until(() => b.log.isGone(env.id));
  assert.equal(await b.previews.blob(preview), null);
  assert.equal(a.files.local(original), null);
  assert.equal(a.files.local(preview), null);
  assert.equal(await a.previews.blob(preview), null);
});

test('quote: a reply carries a snapshot of the quoted message', async () => {
  const [a, b] = await pairManually();
  const question = await a.sendText('Lunch   at\nnoon?');
  await until(() => b.log.has(question.id));
  const reply = await b.sendText('works for me', b.log.get(question.id));
  await until(() => a.log.has(reply.id));
  const got = a.log.get(reply.id);
  assert.equal(got.kind, 'reply');
  assert.equal(got.body.text, 'works for me');
  assert.deepEqual(got.body.q, { id: question.id, name: 'Ada', text: 'Lunch at noon?' });
  await assert.rejects(b.sendText('x'.repeat(DEFAULTS.maxTextLength + 1), question), /too long/);
});

test('connection info: how each known member is connected', async () => {
  const [a, b] = await pairManually();
  const [row] = await a.connectionInfo();
  assert.equal(row.id, b.identity.id);
  assert.equal(row.name, 'Bob');
  assert.equal(row.state, 'p2p');
  assert.deepEqual(row.net, { local: 'host', remote: 'srflx', protocol: 'udp', rtt: 12 });
  [...a.peers.values()][0].link.close();
  await until(() => p2p(a) === 0);
  assert.deepEqual(await a.connectionInfo(), []); // nobody else known
});

// ---- owner: admission, removal, transfer -------------------------------------------------

/** A room whose owner is its creator. */
async function ownedRoom(opts = {}) {
  const identity = await newIdentity();
  return makeRoom({ name: 'Ada', ...opts, identity, owner: identity.id });
}

/** Bring `name` in by the owner's pairing code, as AppModel.joinOffer does. */
async function joinByCode(owner, name, opts = {}) {
  const offer = decodeCode((await owner.createInvite()).code);
  const guest = await makeRoom({ name, secret: offer.roomSecret, owner: offer.founder, ...opts });
  await owner.acceptAnswer(decodeCode((await guest.answerOffer(offer)).code));
  const linked = (r, other) => (
    r.peerList.some((p) => p.id === other.identity.id && p.state === 'p2p')
  );
  const me = guest.identity.id;
  const admitted = () => guest.roster.chain.some((e) => e.kind === 'admit' && e.body.id === me);
  await until(() => linked(owner, guest) && linked(guest, owner) && admitted());
  return guest;
}
const kinds = (room) => room.log.timeline().map((e) => e.kind);

test('owner: pairing by code admits the guest, and then chat flows', async () => {
  const a = await ownedRoom();
  const b = await joinByCode(a, 'Bob');
  assert.equal(b.ownerId, a.identity.id);
  assert.equal(a.roster.isMember(b.identity.id), true);
  await a.sendText('welcome');
  await b.sendText('thanks');
  await until(() => texts(a).includes('thanks') && texts(b).includes('welcome'));
  await assert.rejects(b.createInvite(), /Only the room owner/);
});

test('owner: a latecomer learns the whole membership chain', async () => {
  const a = await ownedRoom();
  const b = await joinByCode(a, 'Bob');
  const c = await joinByCode(a, 'Cy');
  assert.equal(c.roster.isMember(b.identity.id), true);
  assert.equal(c.roster.chain.length, 2);
  await until(() => b.roster.isMember(c.identity.id));
});

test('owner: a secret holder who was never admitted gets nothing and is dropped', async () => {
  const broker = new FakeBroker();
  const a = await ownedRoom({ broker, extra: { relayFallback: false } });
  const eve = await makeRoom({
    name: 'Eve', secret: a.secret, owner: a.ownerId, broker, extra: { relayFallback: false },
  });
  [a, eve].forEach((r) => r.start());
  await until(() => p2p(a) === 1);
  await a.sendText('members only');
  await eve.sendText('let me in');
  await until(() => p2p(a) === 0, 3000); // not admitted within adminTimeoutMs: dropped
  assert.equal(texts(eve).includes('members only'), false);
  assert.equal(texts(a).includes('let me in'), false);
});

test('owner: join request with a greeting, approved, then the guest is in', async () => {
  const broker = new FakeBroker();
  const a = await ownedRoom({ broker });
  a.start();
  const guestId = await newIdentity();
  const settings = {
    ...DEFAULTS, brokersEnabled: true, brokers: ['wss://fake'], presenceIntervalMs: 60,
  };
  const { lobbySecret, ownerId } = await a.joinLinkParts();
  assert.notDeepEqual(lobbySecret, a.secret);
  const ask = new JoinRequest({
    identity: guestId, lobbySecret, ownerId, name: 'Bob', greeting: 'Hi, Bob from the club',
    settings, WS: broker.ws(),
  });
  const approved = new Promise((resolve) => ask.on('approved', resolve));
  await ask.start();
  await until(() => a.joinRequests.length === 1);
  assert.deepEqual(
    [a.joinRequests[0].name, a.joinRequests[0].greeting, a.joinRequests[0].id],
    ['Bob', 'Hi, Bob from the club', guestId.id],
  );
  assert.equal(a.roster.isMember(guestId.id), false); // nothing until the owner says yes
  await a.approveJoin(guestId.id);
  const grant = await approved;
  assert.deepEqual(grant.secret, a.secret);
  const b = await makeRoom({
    name: 'Bob', secret: grant.secret, owner: grant.founder, identity: guestId, broker,
  });
  await b.receiveAdmin(grant.admit);
  b.start();
  await until(() => p2p(a) === 1 && p2p(b) === 1, 5000);
  await a.sendText('welcome Bob');
  await b.sendText('hello all');
  await until(() => texts(a).includes('hello all') && texts(b).includes('welcome Bob'));
  assert.equal(a.joinRequests.length, 0);
  ask.stop();
});

test('owner: a declined join request never receives the room secret', async () => {
  const broker = new FakeBroker();
  const a = await ownedRoom({ broker });
  a.start();
  const guestId = await newIdentity();
  const settings = { ...DEFAULTS, brokersEnabled: true, brokers: ['wss://fake'] };
  const { lobbySecret, ownerId } = await a.joinLinkParts();
  const ask = new JoinRequest({
    identity: guestId, lobbySecret, ownerId, name: 'Eve', greeting: 'let me in', settings,
    WS: broker.ws(),
  });
  let approved = false;
  ask.on('approved', () => { approved = true; });
  await ask.start();
  await until(() => a.joinRequests.length === 1);
  await a.declineJoin(guestId.id);
  await until(() => ask.status === 'declined');
  assert.equal(approved, false);
  assert.equal(a.roster.isMember(guestId.id), false);
  await assert.rejects(a.approveJoin(guestId.id), /no longer open/);
  ask.stop();
});

test('owner: a link with a different owner id reaches nobody', async () => {
  const broker = new FakeBroker();
  const a = await ownedRoom({ broker });
  a.start();
  const guestId = await newIdentity();
  const settings = { ...DEFAULTS, brokersEnabled: true, brokers: ['wss://fake'] };
  const { lobbySecret } = await a.joinLinkParts();
  const ask = new JoinRequest({
    identity: guestId, lobbySecret, ownerId: guestId.id, name: 'Mallory', greeting: 'hi',
    settings, WS: broker.ws(),
  });
  await ask.start();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(a.joinRequests.length, 0);
  ask.stop();
});

test('owner: removing a member drops them, tells them, and keeps them out', async () => {
  const a = await ownedRoom();
  const b = await joinByCode(a, 'Bob');
  const c = await joinByCode(a, 'Cy');
  await until(() => c.roster.isMember(b.identity.id));
  const removed = new Promise((resolve) => b.on('removed', resolve));
  await a.removeMember(b.identity.id);
  await removed;
  assert.equal(b.removed, true);
  await assert.rejects(b.sendText('still here?'), /removed/);
  await until(() => c.roster.revoked.has(b.identity.id) && p2p(a) === 1 && p2p(c) === 1);
  assert.equal(a.peerList.some((p) => p.id === b.identity.id), false);
  assert.deepEqual(a.membersView().map((m) => m.name).sort(), ['Ada', 'Cy']);
  await assert.rejects(c.removeMember(a.identity.id), /Only the room owner/);
  await assert.rejects(a.removeMember(a.identity.id), /Transfer the room first/);
});

test('owner: the owner can delete anyone\'s message, a member only their own', async () => {
  const a = await ownedRoom();
  const b = await joinByCode(a, 'Bob');
  const mine = await a.sendText('from the owner');
  const theirs = await b.sendText('from Bob');
  await until(() => b.log.has(mine.id) && a.log.has(theirs.id));
  await assert.rejects(b.deleteMessage(mine.id), /only delete your own/);
  await a.deleteMessage(theirs.id);
  await until(() => b.log.isGone(theirs.id));
  for (const room of [a, b]) {
    const stub = room.log.timeline().find((e) => e.kind === 'gone');
    assert.equal(stub.name, 'Ada'); // the tombstone says who deleted it
    assert.equal(stub.by, a.identity.id);
  }
  assert.equal(texts(a).includes('from Bob'), false);
});

test('owner: transferring ownership moves every power, and survives a restart', async () => {
  const kv = new MemoryKV();
  const identity = await newIdentity();
  const a = await makeRoom({ name: 'Ada', kv, identity, owner: identity.id });
  const b = await joinByCode(a, 'Bob');
  await assert.rejects(a.transferOwnership(identity.id), /current member/);
  await a.transferOwnership(b.identity.id);
  await until(() => b.isOwner && !a.isOwner);
  assert.equal(a.roster.owner, b.identity.id);
  await assert.rejects(a.createInvite(), /Only the room owner/);
  await assert.rejects(a.removeMember(b.identity.id), /Only the room owner/);
  const c = await joinByCode(b, 'Cy'); // the new owner admits
  assert.equal(c.ownerId, b.identity.id);
  assert.equal(c.roster.founder, a.identity.id); // trust still roots in the room's creator
  await until(() => a.roster.isMember(c.identity.id));
  const again = await makeRoom({
    name: 'Ada', kv, identity, secret: a.secret, owner: identity.id,
  });
  assert.equal(again.roster.owner, b.identity.id); // replayed from the stored chain
  assert.equal(again.roster.isMember(c.identity.id), true);
});

test('owner: membership envelopes are never trimmed from the log', async () => {
  const a = await ownedRoom({ extra: { logCap: 5 } });
  const b = await joinByCode(a, 'Bob', { extra: { logCap: 5 } });
  for (let i = 0; i < 20; i++) await a.sendText(`m${i}`);
  assert.ok(kinds(a).includes('text'));
  assert.equal(a.log.list().filter((e) => e.kind === 'admit').length, 1);
  assert.equal(a.log.list().length <= 6, true);
  assert.equal(b.roster.isMember(b.identity.id) || b.roster.owner === a.identity.id, true);
});

// ---- history after joining, key rotation, recovery ----------------------------------------------

/** Join through the lobby: greeting, owner approval, then open the room as AppModel does. */
async function joinViaLobby(owner, name, broker, extra = {}) {
  const identity = await newIdentity();
  const settings = {
    ...DEFAULTS, brokersEnabled: true, brokers: ['wss://fake'], presenceIntervalMs: 60,
  };
  const { lobbySecret, ownerId } = await owner.joinLinkParts();
  const ask = new JoinRequest({
    identity, lobbySecret, ownerId, name, greeting: `hi from ${name}`, settings, WS: broker.ws(),
  });
  const approved = new Promise((resolve) => ask.on('approved', resolve));
  await ask.start();
  await until(() => owner.joinRequests.some((r) => r.id === identity.id), 4000);
  await owner.approveJoin(identity.id);
  const grant = await approved;
  ask.stop();
  const kv = new MemoryKV();
  if (grant.epoch) await kv.put(`epoch:${owner.id}`, grant.epoch);
  const room = await makeRoom({
    name, secret: grant.secret, owner: grant.founder, identity, broker, kv, extra,
  });
  await room.receiveAdmin(grant.admit);
  room.start();
  return room;
}
const linkedTo = (room, other) => room.peerList.some(
  (p) => p.id === other.identity.id && p.state === 'p2p',
);

test('owner: a new member gets the history from before they joined', async () => {
  const a = await ownedRoom();
  await a.sendText('before you came');
  await a.sendText('and this too');
  const b = await joinByCode(a, 'Bob');
  await until(() => texts(b).includes('before you came') && texts(b).includes('and this too'));
});

test('rotation: removing a member moves the others to keys the removed one lacks', async () => {
  const a = await ownedRoom();
  const [ckv, cid] = [new MemoryKV(), await newIdentity()];
  const b = await joinByCode(a, 'Bob');
  const c = await joinByCode(a, 'Cy', { kv: ckv, identity: cid });
  await until(() => c.roster.isMember(b.identity.id));
  const before = a.channelId;
  assert.equal(c.channelId, before);
  await a.removeMember(b.identity.id);
  await until(() => a.epoch === 1 && c.epoch === 1);
  assert.notEqual(a.channelId, before);
  assert.equal(c.channelId, a.channelId); // the members meet on the new channel...
  assert.equal(b.epoch, 0); // ...the removed one does not know it
  assert.equal(b.channelId, before);
  const again = await makeRoom({
    name: 'Cy', secret: a.secret, owner: a.roster.founder, kv: ckv, identity: cid,
  });
  assert.equal(again.epoch, 1); // survives a restart
  assert.equal(again.channelId, a.channelId);
  assert.equal(a.roster.recoveryKey, null); // an old recovery code names the old keys
});

test('rotation: a later join lands on the new channel, the removed one stays out', async () => {
  const broker = new FakeBroker();
  const a = await ownedRoom({ broker });
  a.start();
  const g1 = await joinViaLobby(a, 'One', broker);
  const g2 = await joinViaLobby(a, 'Two', broker);
  await until(() => linkedTo(a, g1) && linkedTo(a, g2) && linkedTo(g2, g1), 6000);
  const oldLink = a.joinLinkParts();
  await a.removeMember(g1.identity.id);
  await until(() => g2.epoch === 1, 4000);
  const g3 = await joinViaLobby(a, 'Three', broker);
  assert.equal(g3.epoch, 1); // the grant carries the rotation
  await until(() => linkedTo(a, g3) && linkedTo(g2, g3), 6000);
  assert.equal(linkedTo(g1, g3) || linkedTo(g1, a), false);
  assert.notEqual(g1.channelId, a.channelId);
  assert.notDeepEqual((await a.joinLinkParts()).lobbySecret, (await oldLink).lobbySecret);
  await a.sendText('after the rotation');
  const heard = (room) => texts(room).includes('after the rotation');
  await until(() => heard(g3) && heard(g2));
  assert.equal(texts(g1).includes('after the rotation'), false);
});

test('recovery: the owner\'s code takes the room back after the owner is lost', async () => {
  const broker = new FakeBroker();
  const extra = { adminTimeoutMs: 4000 };
  const a = await ownedRoom({ broker, extra });
  a.start();
  const b = await joinViaLobby(a, 'Bob', broker, extra);
  await until(() => linkedTo(a, b) && linkedTo(b, a), 6000);
  const code = decodeRecoveryCode(await a.newRecoveryCode());
  await until(() => b.roster.recoveryKey !== null);
  a.stop(); // the owner's device is gone for good
  await until(() => b.peerList.every((p) => p.state !== 'p2p'));
  const n = await makeRoom({
    name: 'Ada again', secret: code.secret, owner: code.founder, broker, extra,
  });
  n.start();
  await n.beginRecovery(code.seed);
  await until(() => n.isOwner && b.roster.owner === n.identity.id, 8000);
  assert.equal(b.roster.revoked.has(a.identity.id), true);
  assert.equal(b.roster.recoveryKey, null); // the code is used up
  await until(() => b.epoch === 1 && n.epoch === 1, 4000); // and the room is re-keyed
  assert.equal(b.channelId, n.channelId);
  await n.sendText('I am back');
  await until(() => texts(b).includes('I am back'));
  assert.ok(await n.newRecoveryCode()); // the new owner can issue a code of their own
  await assert.rejects(n.transferOwnership(n.identity.id), /current member/);
  n.stop();
  b.stop();
});
