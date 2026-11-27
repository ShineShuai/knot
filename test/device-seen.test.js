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
    connectTimeoutMs: 2000, ...((await kv.get('settings')) ?? {}),
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
  await until(() => [main, one.phone, two.phone].every((m) => m.deviceRows().length === 3), 8000);
  return { broker, main, mainId, mainKv, one, two };
}

const row = (model, pub) => model.deviceRows().find((r) => r.pub === pub);

test('devices that are connected are online and seen now; the others get a time', async () => {
  const { main, one, two } = await three();
  await until(() => row(main, one.pub).online && row(main, two.pub).online, 8000);
  const [a, b] = [row(main, one.pub), row(main, two.pub)];
  assert.ok(Math.abs(a.seen - Date.now()) < 5000, 'online: seen now');
  assert.equal(a.reported, false);
  await until(() => row(main, one.pub).synced && row(main, two.pub).synced, 8000);
  assert.ok(row(main, two.pub).synced <= Date.now());
  await until(() => row(main, two.pub).pv === PROTOCOL, 8000); // each device says it of itself
  assert.equal(b.reported, false);
  const self = main.deviceRows().find((r) => r.self);
  assert.ok(self.online && self.pv === PROTOCOL);
});

test('a device of ours reports protocol levels and times of the others', async () => {
  const { main, mainId, one, two } = await three();
  await until(() => row(main, two.pub).online, 8000);
  // `one` tells `main` what it knows of `two`: a protocol level, and a time further on
  const channel = one.phone.deviceChannel;
  const entry = [...channel.peers.values()].find((e) => e.sibling && toB64u(e.pub) === toB64u(mainId.pub));
  channel.sendToSibling(entry, { t: 'seen', seen: {
    [two.pub]: { ms: Date.now() + 60_000, pv: 9 }, [toB64u(new Uint8Array(32).fill(1))]: { ms: 1, pv: 1 },
  } });
  await until(() => row(main, two.pub).pv === 9, 8000);
  assert.equal(main.deviceRows().length, 3, 'a key that is not one of our devices is ignored');
  // what a device says of itself is first-hand: its own entry arrives with each connection
  await until(() => row(main, one.pub).pv === PROTOCOL, 8000);
});

test('what was seen survives a restart', async () => {
  const { broker, main, mainId, mainKv, one } = await three();
  await until(() => row(main, one.pub).online && row(main, one.pub).synced, 8000);
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
  assert.match(accountLine(main), /^account \S{6} \| device unnamed \S{6} \| original \| 3 devices$/);
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
