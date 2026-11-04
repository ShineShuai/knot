// The member list must reach everyone who needs it. A member who joined after a change that
// another member never saw used to be refused by that member for good when the owner was away:
// the grant carried only their own admission, so nobody online had the whole list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AppModel } from '../src/app.js';
import { JoinRequest } from '../src/chat/join.js';
import { admitBody, createEnvelope } from '../src/chat/envelope.js';
import { lobbyKeys, makeGrant, readDecision } from '../src/chat/lobby.js';
import { Roster } from '../src/chat/roster.js';
import { DEFAULTS } from '../src/config.js';
import { applyDelegation } from '../src/crypto/delegation.js';
import { newBoxKey } from '../src/crypto/box.js';
import { MemoryKV } from '../src/store/kv.js';
import { rosterLines } from '../src/ui/diagnostics.js';
import { HLC } from '../src/util/hlc.js';
import { newIdentity } from './helpers.js';
import { FakeBroker, FakeLink, until } from './fakes.js';

const models = [];
test.afterEach(() => models.splice(0).forEach((m) => m.stop()));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function boot(broker, identity, kv, name) {
  const settings = {
    ...DEFAULTS, name, brokersEnabled: true, brokers: ['wss://fake'], presenceIntervalMs: 80,
    connectTimeoutMs: 500, adminTimeoutMs: 500,
  };
  const model = new AppModel({
    kv, identity: await applyDelegation(identity, kv), settings, iceServers: () => [],
    WS: broker.ws(), linkFactory: () => new FakeLink(),
  });
  await model.load();
  models.push(model);
  return model;
}

async function person(broker, name) {
  const [identity, kv] = [await newIdentity(), new MemoryKV()];
  return { identity, kv, name, model: await boot(broker, identity, kv, name) };
}

const goOffline = (who) => { who.model.stop(); models.splice(models.indexOf(who.model), 1); };
const comeBack = async (broker, who) => (
  { ...who, model: await boot(broker, who.identity, who.kv, who.name) }
);

/** Join through the owner's lobby. `grantOf`: what the new member is given of the answer. */
async function join(broker, ownerRoom, guest, grantOf = (g) => g) {
  const { lobbySecret, ownerId } = await ownerRoom.joinLinkParts();
  const ask = new JoinRequest({
    identity: guest.identity, lobbySecret, ownerId, name: guest.name, greeting: 'hi',
    settings: guest.model.settings, WS: broker.ws(),
  });
  const approved = new Promise((resolve) => ask.on('approved', resolve));
  await ask.start();
  await until(() => ownerRoom.joinRequests.some((q) => q.name === guest.name), 5000);
  await ownerRoom.approveJoin(ownerRoom.joinRequests.find((q) => q.name === guest.name).id);
  const grant = await approved;
  ask.stop();
  return guest.model.completeJoin(grantOf(grant));
}

const room = (who) => [...who.model.rooms.values()][0];
const texts = (r) => r.log.list().filter((e) => e.kind === 'text').map((e) => e.body).sort();

/** Ada is in. She goes offline, the owner changes the list (a recovery code), Bob joins, and the
 *  owner leaves before Bob could ask her for anything. Ada returns: only Bob is online. */
async function lateJoiner(grantOf) {
  const broker = new FakeBroker();
  const owner = await person(broker, 'Olga');
  const ada = await person(broker, 'Ada');
  const home = await owner.model.createRoom('Club');
  await join(broker, home, ada);
  await wait(300);
  goOffline(ada);
  await home.newRecoveryCode(); // a link of the list that Ada never sees
  const bob = await person(broker, 'Bob');
  await join(broker, home, bob, grantOf);
  goOffline(owner);
  return { broker, owner, ada: await comeBack(broker, ada), bob, home };
}

test('a member who joined after a change another member missed is still heard', async () => {
  const { ada, bob } = await lateJoiner();
  await wait(800);
  await room(bob).sendText('hello Ada');
  await until(() => texts(room(ada)).includes('hello Ada'), 8000);
  assert.equal(room(ada).pendingCount, 0);
  assert.equal(room(ada).roster.gap, 0);
});

test('with the old grant (no list) the pair waits for the owner, then heals', async () => {
  const { broker, owner, ada, bob } = await lateJoiner((grant) => ({ ...grant, chain: [] }));
  await wait(800);
  await room(bob).sendText('hello Ada');
  await room(ada).sendText('hello Bob');
  await until(() => texts(room(bob)).includes('hello Bob'), 8000); // Bob accepts Ada
  await until(() => room(ada).pendingCount === 1, 8000); // Ada keeps Bob's message, asking
  assert.deepEqual(texts(room(ada)), ['hello Bob']);
  assert.equal(room(bob).roster.gap, 1, 'Bob knows his list has a hole');
  assert.match(rosterLines(room(bob)).join('\n'), /member list gap: 1 change\(s\) wait/);
  assert.match(rosterLines(room(ada)).join('\n'), /member list: 2 member\(s\), 1 change\(s\)/);

  const home = room(await comeBack(broker, owner)); // whoever has the whole list is back
  assert.ok(home);
  await until(() => texts(room(ada)).includes('hello Ada'), 10_000);
  assert.equal(room(ada).pendingCount, 0);
  await until(() => room(bob).roster.gap === 0, 10_000);
});

test('the grant carries the member list; an older owner sends none, a junk list changes nothing',
  async () => {
    const [owner, joiner, other] = [await newIdentity(), await newIdentity(), await newIdentity()];
    const roster = new Roster(owner.id);
    const hlc = new HLC();
    const sign = (who, kind, body) => createEnvelope(who, hlc, 'room-1', kind, body, 'x');
    for (const who of [joiner, other]) {
      roster.apply(await sign(owner, 'admit', admitBody({ id: who.id, name: 'x' }, roster.head)));
    }
    assert.equal(roster.prefix(1e6).length, 2);
    assert.equal(roster.prefix(1).length, 0, 'what does not fit is left out');
    assert.deepEqual(roster.prefix(1e6), roster.chain);

    const [box, lobbyId] = [await newBoxKey(), (await lobbyKeys(new Uint8Array(16), owner.id)).id];
    const secret = new Uint8Array(16);
    const read = async (payload) => readDecision(
      await makeGrant(owner, { lobbyId, to: joiner.id, boxPub: box.pub, payload }),
      { lobbyId, ownerId: owner.id, selfId: joiner.id, boxKey: box },
    );
    const base = { secret, label: 'Club', admit: roster.chain[1], founder: owner.id, epoch: null };
    assert.deepEqual((await read({ ...base, chain: roster.chain })).chain, roster.chain);
    assert.deepEqual((await read(base)).chain, [], 'an older owner');
    const junk = await read({ ...base, chain: 'nonsense' });
    assert.deepEqual(junk.chain, []);

    // A joiner applies only what verifies and extends the chain.
    const forged = { ...roster.chain[1], body: { ...roster.chain[1].body, name: 'evil' } };
    const broker = new FakeBroker();
    const guest = await person(broker, 'Guest');
    const joined = await guest.model.completeJoin(
      { secret, label: 'Club', founder: owner.id, chain: [forged, 5, null, {}], admit: null },
    );
    assert.equal(joined.roster.members.size, 0);
    assert.equal(joined.roster.gap, 0);
  });
