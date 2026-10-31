// Settings and device aliases are shared by all devices of one identity: the newest change
// wins on every device, whatever the order they arrive in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AppModel } from '../src/app.js';
import { DEFAULTS } from '../src/config.js';
import { DeviceSync, deviceKey, suggestAlias, uniqueAlias } from '../src/chat/device-sync.js';
import { deviceNameOf, verifyEnvelope } from '../src/chat/envelope.js';
import { applyDelegation } from '../src/crypto/delegation.js';
import { toB64u } from '../src/util/bytes.js';
import { newRoomSecret } from '../src/crypto/room-keys.js';
import { MemoryKV } from '../src/store/kv.js';
import { newIdentity } from './helpers.js';
import { FakeLink, until } from './fakes.js';
import { link } from './room-kit.js';

const PUB = 'A'.repeat(43);
const sync = async (settings = { ...DEFAULTS }, id = 'dev1') => {
  const s = new DeviceSync({ kv: new MemoryKV(), settings, deviceId: id });
  await s.load();
  return s;
};

test('a local change is stamped, applied and kept; unchanged values are not', async () => {
  const settings = { ...DEFAULTS, name: 'Ada' };
  const s = await sync(settings);
  assert.deepEqual(await s.set({ name: 'Ada' }), {}, 'same value: nothing to send');
  const sent = await s.set({ name: 'Eve', relayFallback: false });
  assert.deepEqual(Object.keys(sent).sort(), ['name', 'relayFallback']);
  assert.equal(settings.name, 'Eve');
  const again = new DeviceSync({ kv: s.kv, settings: { ...DEFAULTS }, deviceId: 'dev1' });
  await again.load();
  assert.equal(again.items.name.v, 'Eve', 'stored');
  await assert.rejects(s.set({ imagePreviews: 'x' }), /invalid/);
  await assert.rejects(s.set({ notifications: true }), /not shared/);
});

test('merge: the newer stamp wins in any order, ties go to the higher device id', async () => {
  const [a, b] = [{ ...DEFAULTS }, { ...DEFAULTS }];
  const [sa, sb] = [await sync(a, 'devA'), await sync(b, 'devB')];
  const first = await sa.set({ name: 'one' });
  const second = await sb.set({ name: 'two' }); // made later
  await sa.merge(second);
  await sb.merge(first); // older: ignored
  assert.deepEqual([a.name, b.name], ['two', 'two']);
  const tie = { name: { v: 'x', ms: 5, c: 0, by: 'devA' } };
  const tie2 = { name: { v: 'y', ms: 5, c: 0, by: 'devB' } };
  const [s1, s2] = [await sync({ ...DEFAULTS }), await sync({ ...DEFAULTS })];
  await s1.merge(tie); await s1.merge(tie2);
  await s2.merge(tie2); await s2.merge(tie);
  assert.equal(s1.items.name.v, 'y');
  assert.equal(s2.items.name.v, 'y');
});

test('merge refuses unknown keys, bad values and bad shapes', async () => {
  const settings = { ...DEFAULTS, name: 'Ada' };
  const s = await sync(settings);
  const stamp = { ms: 9, c: 0, by: 'x' };
  const taken = await s.merge({
    notifications: { v: true, ...stamp }, name: { v: 'x'.repeat(33), ...stamp },
    brokers: { v: ['ws://insecure'], ...stamp }, imagePreviews: { v: 'tap', ms: -1, c: 0, by: 'x' },
    relayFallback: { v: false, ...stamp },
    [deviceKey('short')]: { v: 'phone', ...stamp }, [deviceKey(PUB)]: { v: 'a\nb', ...stamp },
  });
  assert.deepEqual(Object.keys(taken), ['relayFallback']);
  assert.equal(settings.notifications, false);
  assert.equal(settings.name, 'Ada');
  assert.deepEqual(await s.merge('nonsense'), {});
  assert.deepEqual(await s.merge([1, 2]), {});
});

test('aliases: a tombstone removes a device; seed stamps every shared setting once', async () => {
  const s = await sync();
  await s.set({ [deviceKey(PUB)]: 'phone' });
  assert.equal(s.aliases.get(PUB), 'phone');
  await s.set({ [deviceKey(PUB)]: null });
  assert.equal(s.aliases.size, 0);
  const seeded = await s.seed();
  assert.ok(seeded.name && seeded.brokers && seeded.language);
  assert.deepEqual(await s.seed(), {}, 'only what has no stamp yet');
});

test('suggested and unique aliases', () => {
  assert.equal(suggestAlias({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' }), 'iPhone');
  assert.equal(suggestAlias({ userAgent: 'Mozilla/5.0 (Macintosh)', maxTouchPoints: 5 }), 'iPad');
  assert.equal(suggestAlias({ userAgent: 'Mozilla/5.0 (Macintosh)', maxTouchPoints: 0 }), 'Mac');
  assert.equal(suggestAlias({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel)' }), 'Android');
  assert.equal(suggestAlias({ userAgent: 'Node.js/22' }), null);
  assert.equal(uniqueAlias('Mac', ['Linux']), 'Mac');
  assert.equal(uniqueAlias('Mac', ['mac', 'Mac 2']), 'Mac 3');
  assert.ok(uniqueAlias('x'.repeat(40), ['x'.repeat(16)]).length <= 16);
});

// ---- two real app models: a main device and a linked phone ------------------------------------

const models = [];
test.afterEach(() => models.splice(0).forEach((m) => m.rooms.forEach((r) => r.stop())));

const open = async (identity, kv = new MemoryKV(), name = '') => {
  const settings = { // what the browser would load: defaults, then what was saved
    ...DEFAULTS, name, brokersEnabled: false, brokers: [], gatherTimeoutMs: 10,
    presenceIntervalMs: 60, connectTimeoutMs: 2000, ...((await kv.get('settings')) ?? {}),
  };
  const model = new AppModel({
    kv, identity, settings, iceServers: () => [], linkFactory: () => new FakeLink(),
  });
  await model.load();
  models.push(model);
  return model;
};

/** Main "Ada" and her phone (linked through the real flow), both in one open room, not yet
 *  connected to each other. */
async function devices() {
  const main = await open(await newIdentity(), new MemoryKV(), 'Ada');
  await main.addRoom(newRoomSecret(), 'Club');
  const [phoneId, phoneKv] = [await newIdentity(), new MemoryKV()];
  const first = await open(phoneId, phoneKv);
  const { code, read } = await first.startLinking('Pixel');
  const answer = await main.linkDevice(code);
  await (await read(answer.code)).apply();
  const phone = await open(await applyDelegation(phoneId, phoneKv), phoneKv);
  const [ra, rb] = [main, phone].map((m) => [...m.rooms.values()][0]);
  return { main, phone, ra, rb, phonePub: toB64u(phoneId.pub) };
}

test('linking hands the settings and the phone\'s alias over', async () => {
  const { main, phone, phonePub } = await devices();
  assert.equal(phone.settings.name, 'Ada');
  assert.equal(main.deviceRows().find((r) => r.pub === phonePub).alias, 'Pixel');
  assert.equal(phone.deviceRows().find((r) => r.pub === phonePub).alias, 'Pixel');
  assert.equal(phone.deviceRows().find((r) => r.main).alias, '');
  assert.equal(phone.identity.alias, undefined, 'its own name is the default one');
});

test('the latest change on any device wins on all of them; some settings stay local', async () => {
  const { main, phone, ra, rb } = await devices();
  await link(ra, rb);
  await phone.updateSettings({ name: 'Ada B', relayFallback: false, notifications: true });
  await until(() => main.settings.name === 'Ada B' && main.settings.relayFallback === false);
  assert.equal(main.settings.notifications, false, 'notifications are per device');
  await main.updateSettings({ name: 'Ada C' });
  await until(() => phone.settings.name === 'Ada C');
  assert.equal((await phone.kv.get('settings')).name, 'Ada C', 'kept on disk');
  let heard = null;
  phone.on('settings', (keys) => { heard = keys; });
  await main.updateSettings({ language: 'de' });
  await until(() => phone.settings.language === 'de' && heard?.includes('language'));
});

test('changes made while apart arrive when the devices meet', async () => {
  const { main, phone, ra, rb } = await devices();
  await phone.updateSettings({ name: 'Ada offline' });
  await main.updateSettings({ imagePreviews: 'tap' });
  await link(ra, rb);
  await until(() => main.settings.name === 'Ada offline' && phone.settings.imagePreviews === 'tap');
});

test('an alias chosen on any device shows on messages, connections and in the list', async () => {
  const { main, phone, ra, rb, phonePub } = await devices();
  await link(ra, rb);
  assert.equal(await main.setDeviceAlias(phonePub, 'tablet'), 'tablet');
  await until(() => phone.identity.alias === 'tablet');
  assert.equal(phone.deviceRows().find((r) => r.self).alias, 'tablet');
  const env = await rb.sendText('hello');
  assert.equal(env.al.n, 'tablet');
  assert.equal(deviceNameOf(env), 'tablet');
  assert.ok(await verifyEnvelope(env, rb.id));
  await until(() => ra.log.get(env.id));
  assert.equal(ra.deviceOf(main.identity.member, deviceNameOf(ra.log.get(env.id))), 'tablet');
  await until(() => ra.peerList.some((p) => p.device === 'tablet'));
  // the phone renames the main device, and a taken name gets a number
  const mainPub = toB64u(main.identity.pub);
  assert.equal(await phone.setDeviceAlias(mainPub, 'Tablet'), 'Tablet 2');
  await until(() => main.identity.alias === 'Tablet 2');
  await phone.setDeviceAlias(mainPub, ''); // back to the default
  await until(() => main.identity.alias === undefined);
  await assert.rejects(phone.setDeviceAlias(phonePub, ''), /valid alias/);
  await assert.rejects(phone.setDeviceAlias(phonePub, 'x'.repeat(17)), /valid alias/);
});

test('an alias that was forged on the way is refused', async () => {
  const { phone, rb, phonePub } = await devices();
  await phone.setDeviceAlias(phonePub, 'tablet');
  const env = await rb.sendText('hi');
  assert.ok(await verifyEnvelope(env, rb.id));
  assert.equal(await verifyEnvelope({ ...env, al: { ...env.al, n: 'main' } }, rb.id), false);
  const other = { ...env, id: `${env.id}x`, al: env.al };
  assert.equal(await verifyEnvelope(other, rb.id), false, 'bound to this message');
});
