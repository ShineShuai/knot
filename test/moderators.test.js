// Moderators: members the owner trusts to let people in (while the owner is away) and to delete
// messages. The chain rules, forks between two links made at once, the joiner's check of a
// moderator's grant, and the room as a whole. A moderator cannot remove anyone or change rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  admitBody, authorIdOf, createEnvelope, revokeBody, transferBody,
} from '../src/chat/envelope.js';
import { JoinRequest } from '../src/chat/join.js';
import { makeDeny, makeGrant, readDecision } from '../src/chat/lobby.js';
import { Roster } from '../src/chat/roster.js';
import { DEFAULTS } from '../src/config.js';
import { newBoxKey } from '../src/crypto/box.js';
import { deriveRoomKeys } from '../src/crypto/room-keys.js';
import { decodeCode } from '../src/net/handshake.js';
import { HLC } from '../src/util/hlc.js';
import { newIdentity } from './helpers.js';
import { FakeBroker, until } from './fakes.js';
import { makeRoom, stopRooms, texts } from './room-kit.js';

test.afterEach(stopRooms);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ROOM = 'R'.repeat(22);

// ---- the member chain, without a network ----------------------------------------------------

const hlc = new HLC();
const make = (who, kind, body) => createEnvelope(who, hlc, ROOM, kind, body, 'x');
const admit = (who, target, name, prev, role) => (
  make(who, 'admit', admitBody({ id: target.id, name, role }, prev))
);

/** A roster: Ada owns it; Bob and Cy are moderators; Dee is a plain member. */
async function staffed() {
  const [ada, bob, cy, dee, eve] = await Promise.all(Array.from({ length: 5 }, newIdentity));
  const roster = new Roster(ada.id);
  for (const [who, name, role] of [[bob, 'Bob', 'mod'], [cy, 'Cy', 'mod'], [dee, 'Dee']]) {
    roster.apply(await admit(ada, who, name, roster.head));
    if (role) roster.apply(await admit(ada, who, name, roster.head, role));
  }
  return { ada, bob, cy, dee, eve, roster };
}

/** A copy of `roster` made by replaying its chain. */
const copy = (roster) => { const r = new Roster(roster.founder); r.load(roster.chain); return r; };

test('roster: the owner makes and unmakes moderators; they are members all the same', async () => {
  const { ada, bob, cy, dee, roster } = await staffed();
  assert.deepEqual([...roster.mods].sort(), [bob.id, cy.id].sort());
  assert.equal(roster.isMod(bob.id), true);
  assert.equal(roster.isStaff(ada.id), true);
  assert.equal(roster.isStaff(dee.id), false);
  assert.equal(roster.isMember(bob.id), true);
  roster.apply(await admit(ada, bob, 'Bob', roster.head, 'member'));
  assert.equal(roster.isMod(bob.id), false);
  assert.equal(roster.isMember(bob.id), true, 'still a member');
  assert.equal(roster.apply(await admit(ada, dee, 'Dee', roster.head, 'member')).length, 0,
    'a member who is no moderator cannot be demoted');
  const eve = await newIdentity();
  assert.equal(roster.apply(await admit(ada, eve, 'Eve', roster.head, 'mod')).length, 1,
    'a new member may be let in as a moderator at once');
  assert.equal(roster.isMod(eve.id), true);
});

test('roster: a moderator may only let someone in', async () => {
  const { ada, bob, dee, eve, roster } = await staffed();
  const head = () => roster.head;
  const refused = async (env) => {
    const before = head();
    assert.deepEqual(roster.apply(await env), [], 'refused');
    assert.equal(head(), before);
  };
  const [x, y] = await Promise.all([newIdentity(), newIdentity()]);
  assert.equal(roster.apply(await admit(bob, x, 'X', head())).length, 1, 'a plain admit');
  assert.equal(roster.isMember(x.id), true);
  assert.equal(roster.isMod(x.id), false);
  await refused(admit(bob, y, 'Y', head(), 'mod')); // no promotions
  await refused(admit(bob, ada, 'Ada', head())); // not the owner
  await refused(admit(dee, y, 'Y', head())); // a plain member cannot
  await refused(admit(eve, y, 'Y', head())); // nor a stranger
  await refused(make(bob, 'revoke', revokeBody({ id: x.id }, head()))); // no removals
  await refused(make(bob, 'transfer', transferBody({ to: dee.id }, head())));
  roster.apply(await make(ada, 'revoke', revokeBody({ id: x.id }, head())));
  await refused(admit(bob, x, 'X', head())); // the removed stay removed unless the owner says
  assert.equal(roster.apply(await admit(ada, x, 'X', head())).length, 1, 'the owner may');
});

test('roster: a demoted, removed or replaced moderator cannot let anyone in', async () => {
  const { ada, bob, cy, dee, roster } = await staffed();
  const y = await newIdentity();
  roster.apply(await admit(ada, bob, 'Bob', roster.head, 'member'));
  assert.deepEqual(roster.apply(await admit(bob, y, 'Y', roster.head)), []);
  roster.apply(await make(ada, 'revoke', revokeBody({ id: cy.id }, roster.head)));
  assert.equal(roster.isMod(cy.id), false);
  assert.deepEqual(roster.apply(await admit(cy, y, 'Y', roster.head)), []);
  roster.apply(await admit(ada, dee, 'Dee', roster.head, 'mod'));
  roster.apply(await make(ada, 'transfer', transferBody({ to: dee.id }, roster.head)));
  assert.equal(roster.owner, dee.id);
  assert.equal(roster.isMod(dee.id), false, 'the owner is not also a moderator');
  assert.equal(roster.isMember(ada.id), true, 'the old owner is a member');
});

test('roster: two links at once: the owner wins, between moderators the smaller id', async () => {
  const { ada, bob, cy, roster } = await staffed();
  const [x, y, z] = await Promise.all([newIdentity(), newIdentity(), newIdentity()]);
  const head = roster.head;
  const byBob = await admit(bob, x, 'X', head);
  const byCy = await admit(cy, y, 'Y', head);
  const byAda = await admit(ada, z, 'Z', head);
  const settle = (order) => {
    const r = copy(roster);
    const gone = [];
    for (const env of order) { r.apply(env); gone.push(...r.retracted); }
    return { r, gone };
  };
  const state = (r) => ({ head: r.head, members: [...r.members.keys()].sort() });

  for (const order of [[byBob, byAda], [byAda, byBob]]) {
    const { r } = settle(order);
    assert.equal(r.head, byAda.id, 'the owner wins');
    assert.equal(r.isMember(x.id), false, 'the moderator\'s admit is taken back');
    assert.equal(r.isMember(z.id), true);
  }
  assert.deepEqual(settle([byBob, byAda]).gone, [byBob], 'and said so');
  assert.deepEqual(settle([byAda, byBob]).gone, [], 'nothing taken back when it never held');

  const smaller = byBob.id < byCy.id ? byBob : byCy;
  const a = settle([byBob, byCy]);
  const b = settle([byCy, byBob]);
  assert.equal(a.r.head, smaller.id);
  assert.deepEqual(state(a.r), state(b.r), 'the same in either order');
  assert.equal(settle([byBob, byCy, byBob, byCy]).r.head, smaller.id, 'and when they come twice');
});

test('roster: only a moderator\'s admit is taken back, and only by a stronger link', async () => {
  const { ada, bob, roster } = await staffed();
  const [x, y] = await Promise.all([newIdentity(), newIdentity()]);
  const head = roster.head;

  // an owner's link is final: a moderator's rival is a fork
  const owners = copy(roster);
  owners.apply(await admit(ada, x, 'X', head));
  assert.deepEqual(owners.apply(await admit(bob, y, 'Y', head)), []);
  assert.equal(owners.isMember(x.id), true);
  assert.equal(owners.forks, 1);

  // so is a removal (it changes the room's keys): not even the owner's rival takes it back
  const removal = copy(roster);
  const dee = [...removal.members.keys()].at(-1);
  removal.apply(await make(ada, 'revoke', revokeBody({ id: dee }, head)));
  assert.deepEqual(removal.apply(await admit(bob, y, 'Y', head)), []);
  assert.equal(removal.isMember(dee), false);

  // a rival that would not hold anyway takes nothing back
  const r = copy(roster);
  r.apply(await admit(bob, x, 'X', head));
  const before = [r.head, [...r.members.keys()].sort()];
  const wrongEpoch = { n: 5, commit: 'x'.repeat(43) }; // rotations count up one by one
  const rotate = await make(ada, 'revoke', revokeBody({ id: bob.id, epoch: wrongEpoch }, head));
  assert.deepEqual(r.apply(rotate), []);
  assert.deepEqual([r.head, [...r.members.keys()].sort()], before, 'left as it was');
});

// ---- a moderator's grant, as the joiner sees it ---------------------------------------------

async function grantFixture() {
  const [ada, bob, dee, joiner] = await Promise.all(Array.from({ length: 4 }, newIdentity));
  const secret = new Uint8Array(16).fill(7);
  const roomId = (await deriveRoomKeys(secret)).id;
  const clock = new HLC(); // one clock: two links in the same millisecond must not share an id
  const mk = (who, kind, body) => createEnvelope(who, clock, roomId, kind, body, 'x');
  const chain = [];
  const push = async (who, kind, body) => {
    const env = await mk(who, kind, { ...body, prev: chain.at(-1)?.id ?? '' });
    chain.push(env);
    return env;
  };
  await push(ada, 'admit', { id: bob.id, name: 'Bob' });
  await push(ada, 'admit', { id: bob.id, name: 'Bob', role: 'mod' });
  await push(ada, 'admit', { id: dee.id, name: 'Dee' });
  const admission = await push(bob, 'admit', { id: joiner.id, name: 'Joe' });
  const lobbyId = 'lobby-id';
  const boxKey = await newBoxKey();
  const read = async (signer, overrides = {}, { ownerId = ada.id } = {}) => {
    const payload = {
      secret, label: 'Club', admit: admission, chain, founder: ada.id, epoch: null, ...overrides,
    };
    const bytes = await makeGrant(signer, { lobbyId, to: joiner.id, boxPub: boxKey.pub, payload });
    return readDecision(bytes, { lobbyId, ownerId, selfId: joiner.id, boxKey });
  };
  return { ada, bob, dee, joiner, chain, admission, read, lobbyId, boxKey };
}

test('joiner: a moderator\'s grant counts when the list it carries shows them as one', async () => {
  const { ada, bob, dee, read, admission } = await grantFixture();
  const ok = await read(bob);
  assert.equal(ok?.t, 'grant');
  assert.equal(ok.admit.id, admission.id);
  assert.equal((await read(ada, { admit: admission }))?.t, 'grant', 'the owner always counts');
  assert.equal(await read(dee), null, 'a plain member is not believed');
  assert.equal(await read(bob, {}, { ownerId: dee.id }), null, 'nor under another owner');
});

test('joiner: a moderator\'s grant needs proof, rooted in the owner the link names', async () => {
  const { ada, bob, joiner, chain, read, admission } = await grantFixture();
  assert.equal(await read(bob, { chain: chain.slice(0, 1) }), null, 'no promotion in the list');
  assert.equal(await read(bob, { chain: [] }), null, 'no list');
  assert.equal(await read(bob, { chain: undefined }), null);
  assert.equal(await read(bob, { admit: undefined }), null, 'no admission');
  const stranger = await newIdentity();
  assert.equal(await read(bob, { founder: stranger.id }), null, 'a list of another room');
  const tampered = { ...chain[1], body: { ...chain[1].body, id: joiner.id } };
  assert.equal(await read(bob, { chain: [chain[0], tampered, ...chain.slice(2)] }), null,
    'a forged link');
  const other = await createEnvelope(bob, new HLC(), 'x'.repeat(22), 'admit',
    { id: joiner.id, name: 'Joe', prev: chain.at(-2).id }, 'x');
  assert.equal(await read(bob, { admit: other }), null, 'an admission of another room');
  assert.equal(admission.kind, 'admit');
  assert.ok(ada);
});

test('joiner: a moderator cannot refuse; only the owner\'s refusal is believed', async () => {
  const { ada, bob, joiner, lobbyId, boxKey } = await grantFixture();
  const ask = async (who) => readDecision(
    await makeDeny(who, { lobbyId, to: joiner.id }),
    { lobbyId, ownerId: ada.id, selfId: joiner.id, boxKey },
  );
  assert.deepEqual(await ask(ada), { t: 'deny' });
  assert.equal(await ask(bob), null);
});

// ---- the room ---------------------------------------------------------------------------------

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

test('moderators: the owner makes one; everyone sees it; only the owner can', async () => {
  const a = await ownedRoom();
  const b = await joinByCode(a, 'Bob');
  const c = await joinByCode(a, 'Cy');
  assert.equal(b.isMod, false);
  const env = await a.makeModerator(b.identity.id);
  assert.equal(env.body.role, 'mod');
  await until(() => b.isMod && c.roster.isMod(b.identity.id));
  assert.equal(b.isStaff, true);
  assert.equal(a.isMod, false);
  assert.equal(c.isStaff, false);
  assert.equal(await a.makeModerator(b.identity.id), null, 'already one: nothing is sent');
  assert.equal(c.membersView().find((m) => m.id === b.identity.id).mod, true);
  await assert.rejects(b.makeModerator(c.identity.id), /Only the room owner/);
  await assert.rejects(b.removeModerator(b.identity.id), /Only the room owner/);
  await assert.rejects(b.removeMember(c.identity.id), /Only the room owner/);
  await assert.rejects(b.transferOwnership(c.identity.id), /Only the room owner/);
  await assert.rejects(b.setRules({ post: 'owner' }), /Only the room owner/);
  await assert.rejects(c.makeModerator(c.identity.id), /Only the room owner/);
  await a.removeModerator(b.identity.id);
  await until(() => !b.isMod && !c.roster.isMod(b.identity.id));
  assert.equal(b.roster.isMember(b.identity.id), true, 'still a member');
  await assert.rejects(a.makeModerator('x'.repeat(11)), /current member/);
});

test('moderators: they delete what others wrote, unless the room says not', async () => {
  const a = await ownedRoom();
  const b = await joinByCode(a, 'Bob');
  const c = await joinByCode(a, 'Cy');
  await a.makeModerator(b.identity.id);
  await until(() => b.isMod);
  const theirs = await c.sendText('cy says');
  await until(() => texts(b).includes('cy says') && texts(a).includes('cy says'));
  assert.equal(b.mayDelete(theirs), true);
  assert.equal(c.mayDelete(await a.sendText('ada says')), false, 'a plain member may not');
  await assert.rejects(c.deleteMessage((await a.sendText('more')).id), /only delete your own/);
  await a.setRules({ ownerDelete: false });
  await until(() => b.rules.ownerDelete === false);
  assert.equal(b.mayDelete(theirs), false, 'the room rule binds moderators too');
  await assert.rejects(b.deleteMessage(theirs.id), /cannot delete what others wrote/);
  await a.setRules({ ownerDelete: true });
  await until(() => b.rules.ownerDelete);
  assert.ok(await b.deleteMessage(theirs.id));
  await until(() => !texts(c).includes('cy says') && !texts(a).includes('cy says'));
});

test('moderators: one lets a joiner in while the owner is away, and is believed', async () => {
  const broker = new FakeBroker();
  const a = await ownedRoom({ broker });
  const b = await joinByCode(a, 'Bob', { broker });
  await a.makeModerator(b.identity.id);
  await until(() => b.isMod);
  const { lobbySecret, ownerId } = await b.joinLinkParts();
  assert.equal(ownerId, a.identity.member, 'the link still leads to the owner');
  const settings = {
    ...DEFAULTS, brokersEnabled: true, brokers: ['wss://fake'], presenceIntervalMs: 60,
  };
  const joiner = await newIdentity();
  const request = new JoinRequest({
    identity: joiner, lobbySecret, ownerId, name: 'Joe', greeting: 'hello', settings,
    WS: broker.ws(),
  });
  const decisions = [];
  request.on('approved', (d) => decisions.push(d));
  a.stop(); // the owner is away
  await request.start();
  await until(() => b.joinRequests.some((r) => r.name === 'Joe'), 5000);
  assert.equal(b.joinRequests[0].greeting, 'hello');
  await b.approveJoin(joiner.id);
  await until(() => decisions.length === 1, 5000);
  const [grant] = decisions;
  assert.equal(authorIdOf(grant.admit), b.identity.member, 'the admission is the moderator\'s');
  assert.equal(b.roster.isMember(joiner.id), true);
  assert.equal(b.roster.chain.at(-1).id, grant.admit.id);
  request.stop();
});

test('moderators: a moderator\'s refusal just clears the request; members see none', async () => {
  const broker = new FakeBroker();
  const a = await ownedRoom({ broker });
  a.start(); // the owner listens too: both see every request
  const b = await joinByCode(a, 'Bob', { broker });
  const c = await joinByCode(a, 'Cy', { broker });
  await a.makeModerator(b.identity.id);
  await until(() => b.isMod);
  const { lobbySecret, ownerId } = await b.joinLinkParts();
  const settings = {
    ...DEFAULTS, brokersEnabled: true, brokers: ['wss://fake'], presenceIntervalMs: 60,
  };
  const joiner = await newIdentity();
  const request = new JoinRequest({
    identity: joiner, lobbySecret, ownerId, name: 'Joe', greeting: 'hi', settings, WS: broker.ws(),
  });
  await request.start();
  await until(() => a.joinRequests.length === 1 && b.joinRequests.length === 1, 5000);
  assert.deepEqual(c.joinRequests, [], 'a plain member does not listen');
  await assert.rejects(c.approveJoin(joiner.id), /owner or a moderator/);
  await b.declineJoin(joiner.id);
  assert.equal(b.joinRequests.length, 0);
  await wait(300);
  assert.notEqual(request.status, 'declined', 'the requester is not told');
  assert.equal(a.joinRequests.length, 1, 'the owner still sees it');
  request.stop();
});
