// The device list: who is online now, when each device was last seen and last synced, what
// another device reports, what survives a restart, and the account line of the report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './fake-dom.js';
import { AppModel } from '../src/app.js';
import { DEFAULTS } from '../src/config.js';
import { applyDelegation } from '../src/crypto/delegation.js';
import { PROTOCOL } from '../src/version.js';
import { toB64u } from '../src/util/bytes.js';
import { MemoryKV } from '../src/store/kv.js';
import { accountLine } from '../src/ui/diagnostics.js';
import { deviceTimes } from '../src/ui/settings-devices.js';
import { setLanguage } from '../src/ui/i18n.js';
import { newIdentity } from './helpers.js';
import { FakeBroker, FakeLink, until } from './fakes.js';

installFakeDom();
const models = [];
test.afterEach(() => models.splice(0).forEach((m) => m.stop()));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const net = { brokersEnabled: true, brokers: ['wss://fake'] };
const open = async (identity, kv, name, broker) => {
  const settings = {
    ...DEFAULTS, name, ...net, gatherTimeoutMs: 10, presenceIntervalMs: 60,
    connectTimeoutMs: 2000, messagesPerSecond: 1000, // injected frames come fast ...((await kv.get('settings')) ?? {}),
  };
  const model = new AppModel({
    kv, identity, settings, iceServers: () => [], linkFactory: () => new FakeLink(), WS: broker.ws(),
  });
  await model.load();
  models.push(model);
  return model;
};

async function linkPhone(main, alias, broker) {
  const [id, kv] = [await newIdentity(), new MemoryKV()];
  const first = await open(id, kv, '', broker);
  const { code, read } = await first.startLinking(alias);
  await (await read((await main.linkDevice(code)).code)).apply();
  return { phone: await open(await applyDelegation(id, kv), kv, '', broker), pub: toB64u(id.pub) };
}

async function three() {
  const broker = new FakeBroker();
  const mainId = await newIdentity();
  const mainKv = new MemoryKV();
  const main = await open(mainId, mainKv, 'Ada', broker);
  const [one, two] = [await linkPhone(main, 'One', broker), await linkPhone(main, 'Two', broker)];
  await until(() => [main, one.phone, two.phone].every((m) => m.deviceRows().length === 3));
  return { broker, main, mainId, mainKv, one, two };
}

const row = (model, pub) => model.deviceRows().find((r) => r.pub === pub);

test('devices that are connected are online, seen now, synced and say their level', async () => {
  const { main, one, two } = await three();
  const ready = (pub) => {
    const r = row(main, pub);
    return r.online && r.synced && r.pv === PROTOCOL;
  };
  await until(() => ready(one.pub) && ready(two.pub));
  for (const pub of [one.pub, two.pub]) {
    const r = row(main, pub);
    assert.ok(Math.abs(r.seen - Date.now()) < 10_000, 'online: seen now');
    assert.equal(r.reported, false);
    assert.ok(r.synced <= Date.now());
  }
  const self = main.deviceRows().find((r) => r.self);
  assert.ok(self.online && self.pv === PROTOCOL);
});

test('a device we cannot see is shown by what another device reports of it', async () => {
  const { main, mainId, one, two } = await three();
  const ready = (pub) => row(main, pub).online && row(main, pub).pv === PROTOCOL;
  await until(() => ready(one.pub) && ready(two.pub));
  const mainKey = toB64u(mainId.pub);
  const channel = one.phone.deviceChannel;
  const connected = () => [...channel.peers.values()]
    .find((e) => e.sibling && e.state === 'p2p' && toB64u(e.pub) === mainKey);
  await until(connected); // `one` is connected to `main`, not only the other way round
  two.phone.stop(); // its links close
  await until(() => !row(main, two.pub).online);
  const before = row(main, two.pub).seen;
  // `one` tells `main` over the channel, twice: an older time, then a later one, and a level
  // that is not `two`'s own word, and a key that is not one of our devices
  const tell = (seen) => channel.sendToSibling(connected(), { t: 'seen', seen });
  const unknownKey = toB64u(new Uint8Array(32).fill(1));
  tell({ [two.pub]: { ms: before - 5000, pv: 9 }, [unknownKey]: { ms: 1, pv: 1 } });
  tell({ [two.pub]: { ms: before + 5000, pv: 9 } });
  await until(() => row(main, two.pub).seen >= before + 5000);
  const r = row(main, two.pub);
  assert.equal(r.seen, before + 5000, 'the later time, not the older one');
  assert.equal(r.reported, true, 'now it is another device\'s word');
  assert.equal(r.pv, PROTOCOL, 'its own level stays');
  assert.equal(main.deviceRows().length, 3, 'a key that is not one of our devices is ignored');
});

test('what was seen survives a restart', async () => {
  const { broker, main, mainId, mainKv, one } = await three();
  await until(() => row(main, one.pub).online && row(main, one.pub).synced);
  const before = row(main, one.pub);
  main.stop();
  await wait(50); // the state is written when the model stops
  const again = await open(mainId, mainKv, 'Ada', broker);
  const after = row(again, one.pub);
  assert.ok(after.seen >= before.seen - 1000, 'seen');
  assert.ok(after.synced, 'synced');
});

test('the report names the account, the device, its role and the count', async () => {
  const { main, one } = await three();
  assert.match(accountLine(main), /^account \S{6} \| device device \S{6} \| original \| 3 devices$/);
  assert.match(accountLine(one.phone), /^account \S{6} \| device One \S{6} \| linked \| 3 devices$/);
});

test('a row says online, last seen (reported or first-hand), not seen yet, and warns after 60 days', () => {
  setLanguage('en');
  const text = (r, now) => deviceTimes(r, now).map((n) => n.textContent).join(' | ');
  const now = Date.UTC(2026, 10, 26, 12, 0);
  assert.equal(text({ self: true }, now), '');
  assert.equal(text({ online: true, seen: now }, now), 'online now');
  assert.equal(text({ online: false, seen: null }, now), 'not seen yet');
  assert.match(text({ online: false, seen: now - 1000 }, now), /^last seen \d{4}-\d\d-\d\d \d\d:\d\d$/);
  assert.match(text({ online: false, seen: now - 1000, reported: true }, now), /reported by another device/);
  assert.match(text({ online: false, seen: now - 1000, synced: now - 2000 }, now), / \| synced \d{4}/);
  assert.match(text({ online: false, seen: now - 61 * 864e5 }, now), /not seen for over 60 days/);
  assert.doesNotMatch(text({ online: false, seen: now - 59 * 864e5 }, now), /60 days/);
});

test('the first link gives the original device a name, and the name reaches the other device', async () => {
  const { main, one, two } = await three();
  const original = (m) => m.deviceRows().find((r) => r.original);
  assert.equal(original(main).alias, 'device', 'suggested from what it is (a plain default here)');
  assert.deepEqual([one, two].map((p) => row(main, p.pub).alias), ['One', 'Two'], 'asked for');
  await until(() => original(one.phone).alias === 'device' && original(two.phone).alias === 'device');
});

test('an original device that linked devices before it had a name gets one when it starts', async () => {
  const { broker, main, mainId, mainKv } = await three();
  await main.setDeviceAlias(main.deviceRows().find((r) => r.original).pub, ''); // nameless again
  assert.equal(main.deviceRows().find((r) => r.original).alias, '');
  main.stop();
  await wait(50);
  const again = await open(mainId, mainKv, 'Ada', broker);
  assert.equal(again.deviceRows().find((r) => r.original).alias, 'device');
});

