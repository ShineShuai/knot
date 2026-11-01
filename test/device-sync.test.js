// Settings and device aliases are shared by all devices of one identity: the newest change
// wins on every device, whatever the order they arrive in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AppModel } from '../src/app.js';
import { DEFAULTS } from '../src/config.js';
import {
  DeviceSync, deviceKey, readKey, roomKey, suggestAlias, uniqueAlias,
} from '../src/chat/device-sync.js';
import { deviceNameOf, verifyEnvelope } from '../src/chat/envelope.js';
import { applyDelegation, makeCert } from '../src/crypto/delegation.js';
import { toB64u } from '../src/util/bytes.js';
import { newRoomSecret } from '../src/crypto/room-keys.js';
import { MemoryKV } from '../src/store/kv.js';
import { newIdentity } from './helpers.js';
import { FakeBroker, FakeLink, until } from './fakes.js';
import { readLinkRequest } from '../src/chat/devices.js';
import { RoomChannel } from '../src/net/room-channel.js';
import { deriveRoomKeys } from '../src/crypto/room-keys.js';
import { peerEntries } from '../src/ui/alias.js';
import { link, linkIdentity, makeRoom } from './room-kit.js';

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
test.afterEach(() => models.splice(0).forEach((m) => m.stop()));

const open = async (identity, kv = new MemoryKV(), name = '', extra = {}, WS = undefined) => {
  const settings = { // what the browser would load: defaults, then what was saved
    ...DEFAULTS, name, brokersEnabled: false, brokers: [], gatherTimeoutMs: 10,
    presenceIntervalMs: 60, connectTimeoutMs: 2000, ...extra, ...((await kv.get('settings')) ?? {}),
  };
  const model = new AppModel({
    kv, identity, settings, iceServers: () => [], linkFactory: () => new FakeLink(), WS,
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

test('at the first link a device takes the main device\'s settings, over newer ones', async () => {
  const main = await open(await newIdentity(), new MemoryKV(), 'Ada');
  await main.updateSettings({ name: 'Ada main', language: 'de' });
  const [phoneId, phoneKv] = [await newIdentity(), new MemoryKV()];
  const first = await open(phoneId, phoneKv);
  await first.updateSettings({ name: 'Phone person', relayFallback: false, language: 'zh' });
  const { code, read } = await first.startLinking('Pixel');
  await (await read((await main.linkDevice(code)).code)).apply();
  const phone = await open(await applyDelegation(phoneId, phoneKv), phoneKv);
  assert.equal(phone.settings.name, 'Ada main');
  assert.equal(phone.settings.language, 'de');
  assert.equal(phone.settings.relayFallback, main.settings.relayFallback);
  assert.deepEqual([main.settings.name, main.settings.language], ['Ada main', 'de'], 'unchanged');
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

// ---- rooms and read marks ---------------------------------------------------------------------

test('room items: well-formed ones only; a read mark never moves back', async () => {
  const s = await sync();
  const [id, secret] = ['A'.repeat(16), 'B'.repeat(22)];
  const stamp = { ms: 9, c: 0, by: 'x' };
  const room = (v) => ({ v, ...stamp });
  const taken = await s.merge({
    [roomKey(id)]: room({ s: secret, l: 'Club', o: null }),
    [roomKey('C'.repeat(16))]: room({ s: 'short', l: 'Club', o: null }),
    [roomKey('D'.repeat(16))]: room({ s: secret, l: 'x'.repeat(41), o: null }),
    [roomKey('E'.repeat(16))]: room({ s: secret, l: 'Club', o: 'bad' }),
    [roomKey('F'.repeat(16))]: room({ s: secret, l: 'Club', o: null, extra: 1 }),
    [roomKey('too-short')]: room({ s: secret, l: 'Club', o: null }),
    [readKey(id)]: room({ ms: 5, c: 1 }),
    [readKey('G'.repeat(16))]: room({ ms: -1, c: 0 }),
  });
  assert.deepEqual(Object.keys(taken).sort(), [readKey(id), roomKey(id)].sort());
  const mixed = { [roomKey(id)]: null, [roomKey('C'.repeat(16))]: { s: 'x', l: 'bad', o: null } };
  assert.deepEqual(Object.keys(await s.set(mixed, { lenient: true })), [roomKey(id)], 'lenient');
  await assert.rejects(s.set(mixed), /invalid/);
  await s.set({ [roomKey(id)]: { s: secret, l: 'Club', o: null } });
  assert.deepEqual(await s.set({ [readKey(id)]: { ms: 5, c: 0 } }), {}, 'older: ignored');
  const older = { v: { ms: 4, c: 9 }, ms: 99, c: 0, by: 'z' }; // a newer write of an older mark
  assert.deepEqual(await s.merge({ [readKey(id)]: older }), {});
  assert.ok((await s.set({ [readKey(id)]: { ms: 6, c: 0 } }))[readKey(id)]);
  assert.deepEqual(s.value(readKey(id)), { ms: 6, c: 0 });
  assert.equal((await s.set({ [roomKey(id)]: null }))[roomKey(id)].v, null, 'left');
});

/** Ada's main and phone, plus Bob who writes to both, all in the room "Club"; the devices are
 *  connected to each other. */
async function withBob() {
  const pair = await devices();
  const bob = await makeRoom({ secret: pair.ra.secret, name: 'Bob' });
  await link(pair.ra, bob);
  await link(pair.rb, bob);
  await link(pair.ra, pair.rb);
  return { ...pair, bob };
}

test('a room added on one device appears on the other, also when added while apart', async () => {
  const { main, phone, ra, rb } = await devices();
  const later = await phone.addRoom(newRoomSecret(), 'Later');
  await link(ra, rb);
  await until(() => main.rooms.has(later.id));
  assert.equal(main.rooms.get(later.id).label, 'Later');
  const live = await main.addRoom(newRoomSecret(), 'Live');
  await until(() => phone.rooms.has(live.id));
  assert.deepEqual([...main.rooms.keys()].sort(), [...phone.rooms.keys()].sort());
  const kept = (await main.kv.get('rooms')).map((r) => r.label).sort();
  assert.deepEqual(kept, ['Club', 'Later', 'Live'], 'and kept on disk');
});

test('a room made by one device is owned by the identity, so by the other device too', async () => {
  const { main, phone, ra, rb } = await devices();
  await link(ra, rb);
  const owned = await main.createRoom('Team');
  await until(() => phone.rooms.has(owned.id));
  const copy = phone.rooms.get(owned.id);
  assert.equal(copy.isOwner, true);
  assert.equal(copy.ownerId, owned.ownerId);
  await phone.renameRoom(owned.id, 'Crew');
  await until(() => owned.label === 'Crew');
  await phone.removeRoom(owned.id); // leaving an owned room stays on the device that leaves
  await phone.removeRoom(ra.id);
  await until(() => !main.rooms.has(ra.id));
  assert.ok(main.rooms.has(owned.id), 'an owned room is not taken away from afar');
  assert.equal((await main.kv.get('rooms')).some((r) => r.label === 'Crew'), true);
});

test('leaving a room on one device leaves it on the other; joining again undoes it', async () => {
  const { main, phone, ra, rb } = await devices();
  const [id, secret] = [ra.id, ra.secret];
  await link(ra, rb);
  const second = await main.addRoom(newRoomSecret(), 'Other'); // keeps a link between them
  await until(() => phone.rooms.has(second.id));
  await link(second, phone.rooms.get(second.id));
  await phone.removeRoom(id);
  await until(() => !main.rooms.has(id));
  assert.equal(await main.kv.get(`read:${id}`), undefined, 'its data went too');
  await main.addRoom(secret, 'Club again');
  await until(() => phone.rooms.has(id));
  assert.equal(phone.rooms.get(id).label, 'Club again');
});

test('reading on one device marks the room read on the other, and only forward', async () => {
  const { main, phone, ra, rb, bob } = await withBob();
  await bob.sendText('hi');
  await until(() => ra.unread === 1 && rb.unread === 1);
  await ra.markRead();
  await until(() => rb.unread === 0);
  assert.deepEqual(rb.readStamp, ra.readStamp);
  assert.deepEqual(phone.sync.value(readKey(rb.id)), ra.readStamp);
  const before = ra.readStamp;
  await rb.advanceRead({ ms: 1, c: 0 });
  assert.deepEqual(rb.readStamp, before, 'an older mark changes nothing');
  await bob.sendText('again');
  await until(() => ra.unread === 1 && rb.unread === 1);
  await rb.markRead();
  await until(() => ra.unread === 0);
  assert.ok(main.sync.value(readKey(ra.id)));
});

test('items that do not fit are ignored: a wrong room secret, a bad frame', async () => {
  const { main, ra } = await devices();
  const other = newRoomSecret();
  const stamp = { ms: 9e12, c: 0, by: 'x' };
  const fake = { v: { s: toB64u(other), l: 'Evil', o: null }, ...stamp };
  ra.emit('sync', { [roomKey('A'.repeat(16))]: fake }, null, {});
  ra.emit('sync', 'junk', null, 'junk');
  ra.emit('sync', { [roomKey('A'.repeat(16))]: { v: { s: 1 }, ...stamp } }, null, null);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(main.rooms.size, 1);
});

// ---- no room needed: devices meet in a channel of their own -----------------------------------

const net = { brokersEnabled: true, brokers: ['wss://fake'] };

/** Link a new device `alias` to `main` by the real flow; resolves to the reloaded device. */
async function linkPhone(main, alias, broker) {
  const [id, kv] = [await newIdentity(), new MemoryKV()];
  const first = await open(id, kv, '', net, broker.ws());
  const { code, read } = await first.startLinking(alias);
  await (await read((await main.linkDevice(code)).code)).apply();
  const phone = await open(await applyDelegation(id, kv), kv, '', net, broker.ws());
  return { phone, pub: toB64u(id.pub), id, kv };
}

test('a new device that links to a main device with no rooms stays in step with it', async () => {
  const broker = new FakeBroker();
  const main = await open(await newIdentity(), new MemoryKV(), 'Ada', net, broker.ws());
  await main.updateSettings({ name: 'Ada main' });
  const { phone } = await linkPhone(main, 'Pixel', broker);
  assert.equal(main.rooms.size + phone.rooms.size, 0, 'no room anywhere');
  assert.equal(phone.settings.name, 'Ada main', 'its first state is the main device\'s');
  await main.updateSettings({ name: 'Ada 2', imagePreviews: 'off' });
  const arrived = () => phone.settings.name === 'Ada 2' && phone.settings.imagePreviews === 'off';
  await until(arrived, 8000);
  await phone.updateSettings({ relayFallback: false });
  await until(() => main.settings.relayFallback === false, 8000);
  const club = await main.addRoom(newRoomSecret(), 'Club'); // the first room, made later
  await until(() => phone.rooms.has(club.id), 8000);
  const mine = await phone.createRoom('Mine'); // and a linked device may make one
  await until(() => main.rooms.has(mine.id), 8000);
  assert.equal(main.rooms.get(mine.id).isOwner, true, 'owned by the identity, so by both');
  // saved a moment after the room shows up in memory
  await until(async () => (await main.kv.get('rooms'))?.length === 2, 8000);
});

test('any device unlinks another linked device; the main device stays', async () => {
  const broker = new FakeBroker();
  const main = await open(await newIdentity(), new MemoryKV(), 'Ada', net, broker.ws());
  const [one, two] = [await linkPhone(main, 'One', broker), await linkPhone(main, 'Two', broker)];
  await until(() => [main, one.phone, two.phone].every((m) => m.deviceRows().length === 3), 8000);
  const mainPub = toB64u(main.identity.pub);
  await assert.rejects(one.phone.unlinkDevice(mainPub), /cannot be unlinked/);
  await assert.rejects(one.phone.unlinkDevice(one.pub), /cannot be unlinked/);
  await one.phone.unlinkDevice(two.pub); // the first phone unlinks the second
  assert.equal(one.phone.deviceRows().length, 2);
  await until(() => main.deviceRows().length === 2, 8000);
  assert.equal(main.deviceRows().some((r) => r.pub === two.pub), false);
  await main.unlinkDevice(one.pub); // and the main device the first
  assert.equal(main.deviceRows().length, 1);
  assert.equal(main.paired, false, 'alone again');
});

const requestFrom = async (alias) => (
  await (await open(await newIdentity(), new MemoryKV())).startLinking(alias)
).code;

test('a device cannot be linked to itself; an old self-link is dropped at start', async () => {
  const [id, kv] = [await newIdentity(), new MemoryKV()];
  const model = await open(id, kv, 'Ada');
  const mine = await model.startLinking('Tab two'); // the same browser profile
  await assert.rejects(model.linkDevice(mine.code), /made by this device/);
  assert.ok((await model.linkDevice(await requestFrom('Pixel'))).code, 'another device is fine');
  // what an older version could do: a certificate of the device for itself
  await kv.put('delegate', { cert: await makeCert(id, id.pub, 'Self') });
  const again = await applyDelegation(id, kv);
  assert.ok(!again.cert);
  assert.equal(again.member, id.id, 'speaks as itself');
  assert.ok(!(await kv.get('delegate')), 'and the record is gone');
  const later = await open(again, kv, 'Ada');
  assert.equal(later.isLinked, false);
  assert.ok((await later.linkDevice(await requestFrom('Two'))).code, 'it can link devices again');
});

// ---- reloads and restarts in the middle of linking ---------------------------------------------

test('a code pasted behind an older one is the one that counts', async () => {
  const [one, two] = [await requestFrom('Old'), await requestFrom('Newest')];
  assert.equal((await readLinkRequest(`${one}\n${two}`)).name, 'Newest');
  assert.equal((await readLinkRequest(`${two} and then ${one}`)).name, 'Old', 'the last one');
  assert.equal((await readLinkRequest(`text ${one} text`)).name, 'Old');
});

test('a reload while a device is being linked leaves nothing or a complete link', async () => {
  const main = await open(await newIdentity(), new MemoryKV(), 'Ada');
  await main.updateSettings({ name: 'Ada main' });
  const club = await main.addRoom(newRoomSecret(), 'Club');
  const [id, kv] = [await newIdentity(), new MemoryKV()];
  const first = await open(id, kv, '', {});
  const { code, read } = await first.startLinking('Pixel');
  const grant = await read((await main.linkDevice(code)).code);
  const put = kv.put.bind(kv); // the page goes away after the certificate, before the rest
  kv.put = async (key, value) => (key === 'sync' ? Promise.reject(new Error('page closed'))
    : put(key, value));
  await assert.rejects(grant.apply(), /page closed/);
  kv.put = put;
  assert.ok((await kv.get('delegate')).grant, 'the rest waits beside the certificate');
  const phone = await open(await applyDelegation(id, kv), kv, '', {});
  assert.equal(phone.isLinked, true);
  assert.equal(phone.settings.name, 'Ada main');
  assert.ok(phone.rooms.has(club.id), 'it has the rooms');
  assert.equal(phone.deviceRows().length, 2);
  assert.equal((await kv.get('delegate')).grant, undefined, 'and the work is marked done');
});

test('a reload before the answer is applied: the device asks again, one entry', async () => {
  const main = await open(await newIdentity(), new MemoryKV(), 'Ada');
  const [id, kv] = [await newIdentity(), new MemoryKV()];
  const first = await open(id, kv, '', {});
  const lost = await first.startLinking('Pixel'); // its one-time key is gone after a reload
  const [a, b] = [await main.linkDevice(lost.code), await main.linkDevice(
    (await (await open(id, kv, '', {})).startLinking('Pixel')).code,
  )];
  assert.equal(main.deviceRows().length, 2, 'one entry for the device');
  assert.equal(a.name, b.name, 'with the same alias');
});

test('a main device that stopped while linking still knows its devices after', async () => {
  const [mainId, mainKv] = [await newIdentity(), new MemoryKV()];
  const main = await open(mainId, mainKv, 'Ada');
  const put = mainKv.put.bind(mainKv);
  mainKv.put = async (key, value) => (key === 'linked' ? Promise.reject(new Error('gone'))
    : put(key, value));
  await assert.rejects(main.linkDevice(await requestFrom('Pixel')), /gone/);
  mainKv.put = put;
  main.stop();
  const again = await open(mainId, mainKv, 'Ada');
  assert.equal(again.deviceRows().length, 2);
  assert.equal(again.paired, true);
  assert.ok((await again.linkDevice(await requestFrom('Two'))).code, 'and can link more');
});

// ---- leaving and being withdrawn ---------------------------------------------------------------

test('a withdrawn device starts over as a device of its own, which can link others', async () => {
  const broker = new FakeBroker();
  const main = await open(await newIdentity(), new MemoryKV(), 'Ada', net, broker.ws());
  const one = await linkPhone(main, 'One', broker);
  await until(() => main.paired && one.phone.paired, 8000);
  let heard = 0;
  one.phone.on('unlinked', () => heard++);
  await main.unlinkDevice(one.pub);
  await until(() => heard === 1, 8000); // it hears it even when it shares no room
  assert.ok(!(await one.kv.get('delegate')), 'no longer linked');
  assert.ok(!(await one.kv.get('sync')));
  assert.equal(main.deviceRows().length, 1);
  // after the restart (a new key; the old one stays withdrawn)
  const restarted = await open(await newIdentity(), one.kv, '', net, broker.ws());
  assert.equal(restarted.isLinked, false);
  assert.ok((await restarted.linkDevice(await requestFrom('Other'))).code, 'it links others');
  assert.ok((await (await restarted.startLinking('x')).code), 'and can be linked');
});

test('a linked device can leave the main device on its own', async () => {
  const broker = new FakeBroker();
  const main = await open(await newIdentity(), new MemoryKV(), 'Ada', net, broker.ws());
  const one = await linkPhone(main, 'One', broker);
  await until(() => main.paired && one.phone.paired, 8000);
  let heard = 0;
  one.phone.on('unlinked', () => heard++);
  await one.phone.leaveLink();
  assert.equal(heard, 1);
  assert.ok(!(await one.kv.get('delegate')));
  await until(() => main.deviceRows().length === 1, 8000);
  assert.equal(main.paired, false);
  await assert.rejects(main.leaveLink(), /not linked/);
});

// ---- presence ----------------------------------------------------------------------------------

test('presence names the main identity of a linked device if its certificate fits', async () => {
  const broker = new FakeBroker();
  const [main, phone, stranger] = [await newIdentity(), await newIdentity(), await newIdentity()];
  await linkIdentity(main, phone, 'Pixel');
  const keys = await deriveRoomKeys(newRoomSecret());
  const channel = (selfId) => new RoomChannel({
    roomId: keys.id, aes: keys.aes, selfId, WS: broker.ws(), brokers: ['wss://fake'],
    topicPrefix: 'knot-test',
  });
  const [listener, sender] = [channel('listener'), channel(phone.id)];
  const heard = [];
  listener.on('presence', (p) => heard.push(p));
  [listener, sender].forEach((c) => c.start());
  const say = (who, cert, alias) => until(() => {
    sender.announce({ pub: who.pub, name: 'Ada', cert, alias });
    return heard.some((p) => p.id === who.id);
  });
  await say(phone, phone.cert, 'tablet');
  const ok = heard.find((p) => p.id === phone.id);
  assert.equal(ok.member, main.id);
  assert.equal(ok.device, 'Pixel');
  assert.equal(ok.alias, 'tablet');
  await say(stranger, phone.cert); // somebody else's certificate
  assert.equal(heard.find((p) => p.id === stranger.id).member, undefined);
  [listener, sender].forEach((c) => c.stop());
});

test('a person\'s devices are one entry in the bar even before their links are up', async () => {
  const broker = new FakeBroker();
  const [main, phone] = [await newIdentity(), await newIdentity()];
  await linkIdentity(main, phone, 'Pixel');
  const secret = newRoomSecret();
  const bob = await makeRoom({ secret, name: 'Bob', broker });
  bob.start();
  const keys = await deriveRoomKeys(secret);
  const channel = (selfId) => new RoomChannel({
    roomId: keys.id, aes: keys.aes, selfId, WS: broker.ws(), brokers: ['wss://fake'],
    topicPrefix: DEFAULTS.topicPrefix,
  });
  const senders = [[channel(main.id), main, undefined], [channel(phone.id), phone, phone.cert]];
  senders.forEach(([c]) => c.start());
  const entries = () => peerEntries(bob.peerList);
  await until(() => {
    senders.forEach(([c, who, cert]) => c.announce({ pub: who.pub, name: 'Ada', cert }));
    return bob.peerList.length === 2;
  });
  assert.equal(entries().length, 1, 'one person');
  assert.match(entries()[0].text, /^Ada: (main|Pixel) \(\S+\) \| (main|Pixel) \(\S+\)$/);
  senders.forEach(([c]) => c.stop());
});
