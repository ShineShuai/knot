import test from 'node:test';
import assert from 'node:assert/strict';
import { newBoxKey, openBox, sealBox } from '../src/crypto/box.js';
import { Roster } from '../src/chat/roster.js';
import {
  admitBody, createEnvelope, revokeBody, transferBody, verifyEnvelope,
} from '../src/chat/envelope.js';
import {
  lobbyKeys, lobbySecretOf, makeDeny, makeGrant, makeRequest, readDecision, readRequest,
} from '../src/chat/lobby.js';
import { HLC } from '../src/util/hlc.js';
import { randomBytes, utf8 } from '../src/util/bytes.js';
import { newIdentity } from './helpers.js';

const room = 'room-1';

test('sealed box: only the key holder opens it, only in its context', async () => {
  const [key, other] = [await newBoxKey(), await newBoxKey()];
  const aad = utf8.encode('ctx');
  const sealed = await sealBox(key.pub, utf8.encode('secret'), aad);
  assert.equal(new TextDecoder().decode(await openBox(key.privateKey, sealed, aad)), 'secret');
  await assert.rejects(openBox(other.privateKey, sealed, aad));
  await assert.rejects(openBox(key.privateKey, sealed, utf8.encode('other')));
  await assert.rejects(openBox(key.privateKey, sealed.subarray(0, 40), aad));
});

// ---- roster ---------------------------------------------------------------------------

async function cast() {
  const [owner, ann, bob, eve] = await Promise.all([1, 2, 3, 4].map(newIdentity));
  const hlc = new HLC();
  const roster = new Roster(owner.id);
  const sign = async (who, kind, body) => {
    const env = await createEnvelope(who, hlc, room, kind, body, 'x');
    assert.equal(await verifyEnvelope(env, room), true);
    return env;
  };
  return { owner, ann, bob, eve, roster, sign };
}

test('roster: the owner builds a chain of admissions and removals', async () => {
  const { owner, ann, bob, roster, sign } = await cast();
  assert.equal(roster.isMember(owner.id), true);
  assert.equal(roster.isMember(ann.id), false);
  const a1 = await sign(owner, 'admit', admitBody({ id: ann.id, name: 'Ann' }, roster.head));
  assert.deepEqual(roster.apply(a1), [a1]);
  const a2 = await sign(owner, 'admit', admitBody({ id: bob.id, name: 'Bob' }, roster.head));
  roster.apply(a2);
  assert.deepEqual([...roster.members.keys()], [ann.id, bob.id]);
  const r1 = await sign(owner, 'revoke', revokeBody({ id: ann.id }, roster.head));
  roster.apply(r1);
  assert.equal(roster.isMember(ann.id), false);
  assert.equal(roster.revoked.has(ann.id), true);
  assert.equal(roster.head, r1.id);
  assert.deepEqual(roster.chain.map((e) => e.kind), ['admit', 'admit', 'revoke']);
  assert.deepEqual(roster.apply(a1), []); // replays change nothing
});

test('roster: only the owner extends the chain; forks and bad targets are refused', async () => {
  const { owner, ann, eve, roster, sign } = await cast();
  const forged = await sign(eve, 'admit', admitBody({ id: eve.id, name: 'Eve' }, roster.head));
  assert.deepEqual(roster.apply(forged), []);
  assert.equal(roster.isMember(eve.id), false);
  const first = await sign(owner, 'admit', admitBody({ id: ann.id, name: 'Ann' }, roster.head));
  roster.apply(first);
  const fork = await sign(owner, 'admit', admitBody({ id: eve.id, name: 'Eve' }, ''));
  assert.deepEqual(roster.apply(fork), []); // same predecessor as an envelope already applied
  assert.equal(roster.isMember(eve.id), false);
  const self = await sign(owner, 'revoke', revokeBody({ id: owner.id }, roster.head));
  assert.deepEqual(roster.apply(self), []); // the owner cannot be revoked
  const nobody = await sign(owner, 'transfer', transferBody({ to: eve.id }, roster.head));
  assert.deepEqual(roster.apply(nobody), []); // only to a current member
});

test('roster: envelopes may arrive before their predecessor', async () => {
  const { owner, ann, bob, roster, sign } = await cast();
  const probe = new Roster(owner.id);
  const a1 = await sign(owner, 'admit', admitBody({ id: ann.id, name: 'Ann' }, ''));
  probe.apply(a1);
  const a2 = await sign(owner, 'admit', admitBody({ id: bob.id, name: 'Bob' }, a1.id));
  assert.deepEqual(roster.apply(a2), []); // waits
  assert.equal(roster.isMember(bob.id), false);
  assert.deepEqual(roster.envs(), [a2]); // but is kept, so a peer can complete the chain
  assert.deepEqual(roster.apply(a1), [a1, a2]);
  assert.equal(roster.isMember(bob.id), true);
});

test('roster: ownership moves by transfer; the old owner loses all power', async () => {
  const { owner, ann, bob, roster, sign } = await cast();
  roster.apply(await sign(owner, 'admit', admitBody({ id: ann.id, name: 'Ann' }, roster.head)));
  const move = await sign(owner, 'transfer', transferBody({ to: ann.id }, roster.head));
  assert.deepEqual(roster.apply(move), [move]);
  assert.equal(roster.owner, ann.id);
  assert.equal(roster.founder, owner.id);
  assert.equal(roster.isMember(owner.id), true); // still a member
  const late = await sign(owner, 'admit', admitBody({ id: bob.id, name: 'Bob' }, roster.head));
  assert.deepEqual(roster.apply(late), []);
  const ok = await sign(ann, 'admit', admitBody({ id: bob.id, name: 'Bob' }, roster.head));
  assert.deepEqual(roster.apply(ok), [ok]);
});

test('roster: replaying stored envelopes in any order gives the same state', async () => {
  const { owner, ann, bob, roster, sign } = await cast();
  const envs = [];
  const add = async (who, kind, body) => {
    const env = await sign(who, kind, body);
    roster.apply(env);
    envs.push(env);
  };
  await add(owner, 'admit', admitBody({ id: ann.id, name: 'Ann' }, roster.head));
  await add(owner, 'admit', admitBody({ id: bob.id, name: 'Bob' }, roster.head));
  await add(owner, 'transfer', transferBody({ to: bob.id }, roster.head));
  await add(bob, 'revoke', revokeBody({ id: ann.id }, roster.head));
  const again = new Roster(owner.id);
  again.load([...envs].reverse());
  assert.equal(again.owner, roster.owner);
  assert.equal(again.head, roster.head);
  assert.deepEqual([...again.members.keys()].sort(), [...roster.members.keys()].sort());
  assert.deepEqual([...again.revoked], [ann.id]);
});

// ---- lobby ------------------------------------------------------------------------------

test('lobby secret cannot be turned back into the room secret; the owner is bound in', async () => {
  const secret = randomBytes(16);
  const lobby = await lobbySecretOf(secret);
  assert.equal(lobby.length, 16);
  assert.notDeepEqual(lobby, secret);
  assert.deepEqual(await lobbySecretOf(secret), lobby);
  const [a, b] = [await lobbyKeys(lobby, 'owner-a'), await lobbyKeys(lobby, 'owner-b')];
  assert.notEqual(a.id, b.id); // a forged owner id in a link reaches a different lobby
});

test('lobby: requests are signed, fresh and bound to this lobby', async () => {
  const joiner = await newIdentity();
  const box = await newBoxKey();
  const greeting = 'Hi, it is Bob from the club';
  const ask = { lobbyId: 'L1', name: 'Bob', greeting, boxPub: box.pub };
  const bytes = await makeRequest(joiner, ask);
  const got = await readRequest(bytes, 'L1');
  assert.equal(got.id, joiner.id);
  assert.equal(got.greeting, ask.greeting);
  assert.deepEqual(got.boxPub, box.pub);
  assert.equal(await readRequest(bytes, 'L2'), null);
  const tampered = JSON.parse(new TextDecoder().decode(bytes));
  tampered.greeting = 'let me in';
  assert.equal(await readRequest(utf8.encode(JSON.stringify(tampered)), 'L1'), null);
  const old = await makeRequest(joiner, { ...ask, now: Date.now() - 3_600_000 });
  assert.equal(await readRequest(old, 'L1'), null);
  const long = await makeRequest(joiner, { ...ask, greeting: 'x'.repeat(500) });
  assert.equal((await readRequest(long, 'L1')).greeting.length, 200);
});

test('lobby: a grant opens only for the intended joiner, from the real owner', async () => {
  const [owner, joiner, other] = await Promise.all([1, 2, 3].map(newIdentity));
  const box = await newBoxKey();
  const secret = randomBytes(16);
  const admit = { kind: 'admit', id: 'x' };
  const bytes = await makeGrant(owner, {
    lobbyId: 'L', to: joiner.id, boxPub: box.pub,
    payload: { secret, label: 'Club', admit, founder: 'FOUNDER1234' },
  });
  const read = (opts) => readDecision(bytes, {
    lobbyId: 'L', ownerId: owner.id, selfId: joiner.id, boxKey: box, ...opts,
  });
  const got = await read({});
  assert.deepEqual(got.secret, secret);
  assert.equal(got.label, 'Club');
  assert.deepEqual(got.admit, admit);
  assert.equal(got.founder, 'FOUNDER1234');
  assert.equal(await read({ selfId: other.id }), null); // meant for someone else
  assert.equal(await read({ ownerId: other.id }), null); // not signed by the owner we expect
  assert.equal(await read({ lobbyId: 'M' }), null);
  assert.equal(await read({ boxKey: await newBoxKey() }), null); // not our one-time key
  const deny = await makeDeny(owner, { lobbyId: 'L', to: joiner.id });
  const refused = await readDecision(deny, {
    lobbyId: 'L', ownerId: owner.id, selfId: joiner.id, boxKey: box,
  });
  assert.deepEqual(refused, { t: 'deny' });
  assert.equal(await readDecision(deny, {
    lobbyId: 'L', ownerId: owner.id, selfId: other.id, boxKey: box,
  }), null);
});
