// The room rules the owner sets (join, post, files, calls): one signed `policy` envelope, held
// by every member, enforced on what comes in and refused before it goes out.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authorIdOf, createEnvelope, delBody, fileBody, verifyEnvelope,
} from '../src/chat/envelope.js';
import { JoinRequest } from '../src/chat/join.js';
import {
  DEFAULT_RULES, POLICY, Policy, policyBody, rulesOf, validPolicyBody,
} from '../src/chat/policy.js';
import { DEFAULTS } from '../src/config.js';
import { decodeCode } from '../src/net/handshake.js';
import { MemoryKV } from '../src/store/kv.js';
import { HLC } from '../src/util/hlc.js';
import { newIdentity } from './helpers.js';
import { FakeBroker, until } from './fakes.js';
import { makeRoom, stopRooms, texts } from './room-kit.js';

test.afterEach(stopRooms);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ownedRoom(opts = {}) {
  const identity = await newIdentity();
  return makeRoom({ name: 'Ada', ...opts, identity, owner: identity.id });
}

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

/** An envelope as a modified app would make it, stamped `ago` ms before now. */
const craft = (who, room, kind, body, ago = 0) => createEnvelope(
  who, { tick: () => ({ ms: Date.now() - ago, c: 0 }) }, room.id, kind, body, who.name ?? 'x',
);
const policies = (room) => room.log.list().filter((e) => e.kind === POLICY);

test('rules: a missing or odd value is the default; unknown ones are left out', () => {
  assert.deepEqual(rulesOf({}), DEFAULT_RULES);
  assert.deepEqual(rulesOf({ post: 'owner', files: 'no', slow: 5 }),
    { ...DEFAULT_RULES, post: 'owner' });
  assert.deepEqual(Object.keys(policyBody(2, { calls: false })), ['rev', 'rules']);
  assert.deepEqual(Object.keys(policyBody(2, {}).rules),
    ['join', 'post', 'files', 'calls', 'name', 'ownerDelete', 'maxFileMb']);
});

test('rules: what a policy body may hold', () => {
  const ok = (rules, rev = 1) => validPolicyBody({ rev, rules });
  assert.equal(ok({ join: 'closed', post: 'owner', files: false, calls: false }), true);
  assert.equal(ok({}), true);
  assert.equal(ok({ slow: 30, motto: 'hello' }), true, 'rules of newer versions pass');
  for (const bad of [{ join: 'open' }, { post: 'members' }, { files: 1 }, { calls: 'no' },
    { slow: { deep: 1 } }, { slow: 'x'.repeat(33) },
    Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i]))]) {
    assert.equal(ok(bad), false, JSON.stringify(bad).slice(0, 40));
  }
  for (const rev of [0, -1, 1.5, 1e7, '1', null]) assert.equal(ok({}, rev), false, String(rev));
  assert.equal(validPolicyBody(null), false);
  assert.equal(validPolicyBody({ rev: 1, rules: [] }), false);
});

test('rules: the newest wins; ties go by id; stamps decide what is judged', () => {
  const policy = new Policy();
  const env = (rev, id, rules = {}, ms = 1000) => (
    { id, ms, c: 0, kind: POLICY, body: policyBody(rev, rules) }
  );
  assert.equal(policy.supersedes(env(1, 'a')), true);
  policy.set(env(2, 'b', { post: 'owner' }));
  assert.equal(policy.supersedes(env(1, 'z')), false);
  assert.equal(policy.supersedes(env(2, 'a')), false);
  assert.equal(policy.supersedes(env(2, 'c')), true);
  assert.equal(policy.supersedes(env(3, 'a')), true);
  assert.equal(policy.custom, true);
  const text = (ms) => ({ kind: 'text', ms, c: 0 });
  assert.equal(policy.permits(text(2000), 'bob', 'ada'), false, 'later than the rules: judged');
  assert.equal(policy.permits(text(2000), 'ada', 'ada'), true, 'the owner may');
  assert.equal(policy.permits(text(500), 'bob', 'ada'), true, 'earlier: not judged');
  assert.equal(policy.permits({ kind: 'react', ms: 2000, c: 0 }, 'bob', 'ada'), true);
  assert.equal(new Policy().custom, false);
});

test('rules: a policy envelope is signed like any other, and bad ones do not verify', async () => {
  const owner = await newIdentity();
  const env = await craft(owner, { id: 'r1' }, POLICY, policyBody(1, { post: 'owner' }));
  assert.equal(await verifyEnvelope(env, 'r1'), true);
  const odd = await craft(owner, { id: 'r1' }, POLICY, { rev: 1, rules: { post: 'x' } });
  assert.equal(await verifyEnvelope(odd, 'r1'), false);
  const tampered = { ...env, body: policyBody(1, { post: 'all' }) };
  assert.equal(await verifyEnvelope(tampered, 'r1'), false);
});

test('rules: the owner sets them, members see them, the notice says who', async () => {
  const a = await ownedRoom();
  const b = await joinByCode(a, 'Bob');
  assert.deepEqual(b.rules, DEFAULT_RULES);
  assert.equal(await a.setRules({}), null, 'nothing changes: nothing is sent');
  const env = await a.setRules({ post: 'owner', calls: false });
  assert.equal(env.body.rev, 1);
  await until(() => b.rules.post === 'owner');
  assert.deepEqual(b.rules, { ...DEFAULT_RULES, post: 'owner', calls: false });
  assert.equal(b.policy.rev, 1);
  assert.equal(b.log.timeline().some((e) => e.kind === POLICY), true, 'shown in the conversation');
  await assert.rejects(b.setRules({ post: 'all' }), /Only the room owner/);
  await assert.rejects(a.setRules({ join: 'nope' }), /not valid/);
  assert.equal((await a.setRules({ post: 'all' })).body.rev, 2);
  await until(() => b.rules.post === 'all' && b.policy.rev === 2);
});

test('rules: post by the owner only; a member is refused before and after sending', async () => {
  const a = await ownedRoom();
  const b = await joinByCode(a, 'Bob');
  await a.setRules({ post: 'owner' });
  await until(() => b.rules.post === 'owner');
  await assert.rejects(b.sendText('hi'), /Only the room owner can write here/);
  await assert.rejects(b.shareFile(new File(['x'], 'x.txt')), /Only the room owner can write here/);
  await a.sendText('news');
  await until(() => texts(b).includes('news'));
  const mallory = b.identity; // a modified app that skips its own check
  await wait(5);
  const forged = await craft(mallory, a, 'text', 'hello anyway');
  assert.equal(await a.receiveAdmin(forged), false);
  assert.equal(a.log.has(forged.id), false);
  assert.equal(a.dropped['against the room rules'].n, 1);
  const first = a.log.list().find((e) => e.body === 'news');
  assert.ok(await b.react(first.id, '👍'), 'reactions are not posts');
  await a.setRules({ post: 'all' });
  await until(() => b.rules.post === 'all');
  assert.ok(await b.sendText('thanks'));
});

test('rules: what was written before the rules is not judged', async () => {
  const a = await ownedRoom();
  const b = await joinByCode(a, 'Bob');
  await a.setRules({ post: 'owner' });
  const old = await craft(b.identity, a, 'text', 'from before', 60_000);
  assert.equal(await a.receiveAdmin(old), true, 'history keeps its messages');
  assert.deepEqual(texts(a), ['from before']);
});

test('rules: files off, for everyone', async () => {
  const a = await ownedRoom();
  const b = await joinByCode(a, 'Bob');
  await a.setRules({ files: false });
  await until(() => !b.rules.files);
  await assert.rejects(b.shareFile(new File(['x'], 'x.txt')), /Sharing files is turned off/);
  await assert.rejects(a.shareFile(new File(['x'], 'x.txt')), /Sharing files is turned off/);
  await wait(5);
  const body = fileBody({
    id: 'AAAAAAAAAAA', name: 'x.txt', size: 1, mime: 'text/plain', sha256: 'A'.repeat(43),
  });
  assert.equal(await a.receiveAdmin(await craft(b.identity, a, 'file', body)), false);
  await a.sendText('words are fine');
  await until(() => texts(b).includes('words are fine'));
});

test('rules: calls off; nobody joins, frames are ignored', async () => {
  const a = await ownedRoom();
  const b = await joinByCode(a, 'Bob');
  await a.setRules({ calls: false });
  await until(() => !b.rules.calls);
  await assert.rejects(b.call.join(), /Calls are turned off/);
  b.call.onFrame(a.identity.id, { k: 'in', a: true, v: false, s: false });
  assert.equal(b.call.members.size, 0);
  await a.setRules({ calls: true });
  await until(() => b.rules.calls);
  b.call.onFrame(a.identity.id, { k: 'in', a: true, v: false, s: false });
  assert.equal(b.call.members.size, 1);
});

test('rules: only the current owner sets them, and only the newest counts', async () => {
  const a = await ownedRoom();
  const b = await joinByCode(a, 'Bob');
  await a.setRules({ post: 'owner' });
  await a.setRules({ post: 'all', files: false });
  await until(() => b.policy.rev === 2);
  const member = await craft(b.identity, a, POLICY, policyBody(9, { post: 'owner' }));
  assert.equal(await a.receiveAdmin(member), false, 'a member cannot');
  assert.equal(a.policy.rev, 2);
  const stale = await craft(a.identity, a, POLICY, policyBody(1, { post: 'owner' }));
  assert.equal(await a.receiveAdmin(stale), false, 'an older revision is ignored');
  assert.deepEqual(a.rules, { ...DEFAULT_RULES, files: false });
  const stranger = await newIdentity();
  assert.equal(await a.receiveAdmin(await craft(stranger, a, POLICY, policyBody(3, {}))), false);
  assert.equal(policies(a).length, 1, 'one set of rules is kept');
});

test('rules: rules of a newer version still verify; what we do not know is ignored', async () => {
  const a = await ownedRoom();
  const b = await joinByCode(a, 'Bob');
  const body = { rev: 1, rules: { ...rulesOf({ post: 'owner' }), slow: 30 } };
  const env = await craft(a.identity, a, POLICY, body);
  assert.equal(await b.receiveAdmin(env), true);
  assert.deepEqual(b.rules, { ...DEFAULT_RULES, post: 'owner' });
  assert.equal(b.policy.env.body.rules.slow, 30, 'kept in the envelope, as signed');
});

test('rules: kept through a restart and never trimmed from the log', async () => {
  const [kv, identity] = [new MemoryKV(), await newIdentity()];
  const a = await makeRoom({ name: 'Ada', kv, identity, owner: identity.id, extra: { logCap: 5 } });
  await a.setRules({ post: 'owner' });
  await a.setRules({ post: 'owner', files: false });
  for (let i = 0; i < 20; i++) await a.sendText(`m${i}`);
  assert.equal(policies(a).length, 1);
  const again = await makeRoom({
    name: 'Ada', kv, identity, secret: a.secret, owner: identity.id, extra: { logCap: 5 },
  });
  assert.deepEqual(again.rules, { ...DEFAULT_RULES, post: 'owner', files: false });
  assert.equal(again.policy.rev, 2);
});

test('rules: a room without an owner has none, and cannot be given any', async () => {
  const a = await makeRoom({ name: 'Ada' });
  assert.deepEqual(a.rules, DEFAULT_RULES);
  await assert.rejects(a.setRules({ post: 'owner' }), /Only the room owner/);
  const owner = await newIdentity();
  const env = await craft(owner, a, POLICY, policyBody(1, { post: 'owner' }));
  assert.equal(await a.receiveAdmin(env), false);
  assert.equal(a.log.has(env.id), false);
});

test('rules: a new owner signs them again, so a later member accepts them', async () => {
  const a = await ownedRoom();
  const b = await joinByCode(a, 'Bob');
  await a.setRules({ post: 'owner' });
  await until(() => b.rules.post === 'owner');
  await a.transferOwnership(b.identity.id);
  await until(() => b.isOwner);
  await until(() => b.policy.rev === 2 && b.isMine(authorIdOf(b.policy.env)));
  await until(() => a.policy.rev === 2, 3000);
  const c = await joinByCode(b, 'Cy');
  await until(() => c.rules.post === 'owner', 5000);
  await assert.rejects(c.sendText('hi'), /Only the room owner/);
  assert.equal(a.rules.post, 'owner', 'the old owner is now a member under the same rules');
});

test('rules: closed to new members: the owner stops answering, and starts again', async () => {
  const broker = new FakeBroker();
  const a = await ownedRoom({ broker });
  a.start();
  const settings = {
    ...DEFAULTS, brokersEnabled: true, brokers: ['wss://fake'], presenceIntervalMs: 60,
  };
  const { lobbySecret, ownerId } = await a.joinLinkParts();
  const ask = async (name) => {
    const request = new JoinRequest({
      identity: await newIdentity(), lobbySecret, ownerId, name, greeting: 'hi', settings,
      WS: broker.ws(),
    });
    await request.start();
    return request;
  };
  const first = await ask('Early');
  await until(() => a.joinRequests.length === 1);
  await a.setRules({ join: 'closed' });
  await wait(100);
  assert.equal(a.joinRequests.length, 0, 'open requests are dropped');
  const late = await ask('Late');
  await wait(300);
  assert.equal(a.joinRequests.length, 0, 'a closed room hears nobody');
  await a.setRules({ join: 'approve' });
  const again = await ask('Again');
  await until(() => a.joinRequests.some((q) => q.name === 'Again'), 5000);
  [first, late, again].forEach((r) => r.stop());
});

test('rules: name, delete and file size are checked like the others', () => {
  const ok = (rules) => validPolicyBody({ rev: 1, rules });
  assert.equal(ok({ name: 'Team Alpha', ownerDelete: false, maxFileMb: 5 }), true);
  assert.equal(ok({ name: '' }), true, 'no name for everyone');
  for (const bad of [{ name: 'x'.repeat(33) }, { name: 'a\u202eb' }, { name: 7 },
    { ownerDelete: 'no' }, { maxFileMb: -1 }, { maxFileMb: 1.5 }, { maxFileMb: '5' },
    { maxFileMb: 1e6 }]) {
    assert.equal(ok(bad), false, JSON.stringify(bad));
  }
  const policy = new Policy();
  policy.set({ id: 'a', ms: 1000, c: 0, kind: POLICY, body: policyBody(1, {
    maxFileMb: 1, ownerDelete: false,
  }) });
  const MB = 1024 * 1024;
  assert.equal(policy.denies('file', 'bob', 'ada', { size: 2 * MB }), 'size');
  assert.equal(policy.denies('file', 'bob', 'ada', { size: MB }), null, 'up to the limit');
  assert.equal(policy.denies('del', 'ada', 'ada', { target: 'bob' }), 'delete');
  assert.equal(policy.denies('del', 'ada', 'ada', { target: 'ada' }), null, 'her own');
  assert.equal(policy.denies('del', 'bob', 'ada', { target: 'bob' }), null, 'the author');
  assert.equal(new Policy().denies('del', 'ada', 'ada', { target: 'bob' }), null, 'by default');
});

test('rules: the owner may not delete what others wrote, when the room says so', async () => {
  const a = await ownedRoom();
  const b = await joinByCode(a, 'Bob');
  const theirs = await b.sendText('bob says');
  await until(() => texts(a).includes('bob says'));
  const mine = await a.sendText('ada says');
  await until(() => texts(b).includes('ada says'));
  assert.equal(a.mayDelete(theirs), true, 'by default the owner may');
  await a.setRules({ ownerDelete: false });
  await until(() => b.rules.ownerDelete === false);
  assert.equal(a.mayDelete(theirs), false);
  assert.equal(a.mayDelete(mine), true);
  assert.equal(b.mayDelete(theirs), true, 'the author always may');
  await assert.rejects(a.deleteMessage(theirs.id), /cannot delete what others wrote/);
  await wait(5);
  const forced = await craft(a.identity, b, 'del', delBody(theirs.id));
  assert.equal(await b.receiveAdmin(forced), false, 'refused on receipt too');
  assert.ok(await a.deleteMessage(mine.id), 'her own is hers to delete');
  assert.ok(await b.deleteMessage(theirs.id), 'and his is his');
  await a.setRules({ ownerDelete: true });
  const again = await b.sendText('one more');
  await until(() => texts(a).includes('one more'));
  assert.ok(await a.deleteMessage(again.id), 'allowed again');
});

test('rules: the largest file: the room limit is lower than ours, never higher', async () => {
  const a = await ownedRoom();
  const b = await joinByCode(a, 'Bob');
  const MB = 1024 * 1024;
  assert.equal(a.fileLimit, a.settings.maxFileBytes);
  await a.setRules({ maxFileMb: 1 });
  await until(() => b.rules.maxFileMb === 1);
  assert.equal(b.fileLimit, MB);
  await assert.rejects(b.shareFile(new File([new Uint8Array(2 * MB)], 'big.bin')), /too large/);
  await wait(5);
  const meta = (size) => fileBody({
    id: 'AAAAAAAAAAA', name: 'x.bin', size, mime: 'application/octet-stream',
    sha256: 'A'.repeat(43),
  });
  const big = await craft(b.identity, a, 'file', meta(2 * MB));
  assert.equal(await a.receiveAdmin(big), false, 'a bigger one is refused on receipt');
  assert.equal(a.dropped['against the room rules'].n, 1);
  const small = await craft(b.identity, a, 'file', meta(MB / 2));
  assert.equal(await a.receiveAdmin(small), true);
  await a.setRules({ maxFileMb: 0 });
  await until(() => b.fileLimit === b.settings.maxFileBytes);
  b.settings.maxFileBytes = MB; // a person's own limit is never raised by the room
  await a.setRules({ maxFileMb: 50 });
  await until(() => b.rules.maxFileMb === 50);
  assert.equal(b.fileLimit, MB);
});

test('rules: a name for everyone, unless we chose our own', async () => {
  const a = await ownedRoom({ label: 'First' });
  const b = await joinByCode(a, 'Bob');
  assert.equal(b.title, b.label, 'no rule, no own name: the first name');
  await a.setRules({ name: 'Team Alpha' });
  await until(() => b.title === 'Team Alpha');
  assert.equal(a.title, 'Team Alpha');
  b.prefs = { name: 'My team' };
  assert.equal(b.title, 'My team', 'ours wins');
  b.prefs = {};
  assert.equal(b.title, 'Team Alpha');
  await a.setRules({ name: '' });
  await until(() => b.title === b.label);
  await assert.rejects(a.setRules({ name: 'x'.repeat(33) }), /not valid/);
  await assert.rejects(a.setRules({ name: 'a\u202eb' }), /not valid/);
});
