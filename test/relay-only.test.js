// Pairs that cannot connect directly (NAT without a way through) have only the brokers. The member
// list, the messages that were missed and the messages of people the list does not know yet must
// all still arrive: nobody may see only themselves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AppModel } from '../src/app.js';
import { JoinRequest } from '../src/chat/join.js';
import { DEFAULTS } from '../src/config.js';
import { applyDelegation } from '../src/crypto/delegation.js';
import { MemoryKV } from '../src/store/kv.js';
import { dropLines } from '../src/ui/diagnostics.js';
import { newIdentity } from './helpers.js';
import { DeadLink, FakeBroker, until } from './fakes.js';

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
    WS: broker.ws(), linkFactory: () => new DeadLink(),
  });
  await model.load();
  models.push(model);
  return model;
}

async function person(broker, name) {
  const [identity, kv] = [await newIdentity(), new MemoryKV()];
  return { identity, kv, name, model: await boot(broker, identity, kv, name) };
}

async function linkPhone(broker, main, name) {
  const [identity, kv] = [await newIdentity(), new MemoryKV()];
  const fresh = await boot(broker, identity, kv, '');
  const { code, read } = await fresh.startLinking(name);
  const answer = await main.model.linkDevice(code);
  await (await read(answer.code)).apply();
  fresh.stop();
  models.splice(models.indexOf(fresh), 1);
  const model = await boot(broker, identity, kv, '');
  return { identity, kv, name: `${main.name}-${name}`, model };
}

/** Join an owned room the way the join link does: through the owner's lobby, over the brokers. */
async function joinByLink(broker, ownerRoom, guest) {
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
  return guest.model.completeJoin(grant);
}

const room = (device) => [...device.model.rooms.values()][0];
const texts = (r) => r.log.list().filter((e) => e.kind === 'text').map((e) => e.body).sort();

test('brokers only: owner, two members and a linked device each all see each other', async () => {
  const broker = new FakeBroker();
  const [owner, ada, bob] = [
    await person(broker, 'Olga'), await person(broker, 'Ada'), await person(broker, 'Bob'),
  ];
  const home = await owner.model.createRoom('Club');
  await joinByLink(broker, home, ada);
  await joinByLink(broker, home, bob); // Bob joins after Ada: he never saw Ada's admission
  const [adaPhone, bobTablet] = [
    await linkPhone(broker, ada, 'phone'), await linkPhone(broker, bob, 'tablet'),
  ];
  const all = [owner, ada, adaPhone, bob, bobTablet];
  await until(() => all.every((d) => d.model.rooms.size === 1), 6000);
  const said = all.map((d) => `from ${d.name}`);
  for (const d of all) { await room(d).sendText(`from ${d.name}`); await wait(60); }
  await until(() => all.every((d) => said.every((s) => texts(room(d)).includes(s))), 12_000);
});

test('a message of someone the member list does not know waits for it, and shows up', async () => {
  const broker = new FakeBroker();
  const [owner, ada, bob] = [
    await person(broker, 'Olga'), await person(broker, 'Ada'), await person(broker, 'Bob'),
  ];
  const home = await owner.model.createRoom('Club');
  await joinByLink(broker, home, ada);
  await until(() => room(ada).peerList.some((p) => p.state === 'relay'), 4000);
  await joinByLink(broker, home, bob);
  const bobRoom = room(bob);
  await room(ada).sendText('hello Bob');
  await until(() => texts(bobRoom).includes('hello Bob'), 8000);
  await until(() => bobRoom.pendingCount === 0, 2000); // nothing is left waiting
});

test('the diagnostics say why messages were refused', async () => {
  const broker = new FakeBroker();
  const owner = await person(broker, 'Olga');
  const home = await owner.model.createRoom('Club');
  const last = { at: Date.now() - 5000, by: 'x', name: 'Ada' };
  home.dropped['author not in member list'] = { n: 3, last };
  const lines = dropLines(home).join('\n');
  assert.match(lines, /refused 3x: author not in member list, last \d+ s ago/);
  assert.match(lines, /brokers reachable/);
});
