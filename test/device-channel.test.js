// The channel where a person's devices meet: what was withdrawn is refused again after a
// restart, and the devices that are left keep meeting there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AppModel } from '../src/app.js';
import { DEFAULTS } from '../src/config.js';
import { CHANNEL } from '../src/chat/device-sync.js';
import { applyDelegation } from '../src/crypto/delegation.js';
import { newRoomSecret } from '../src/crypto/room-keys.js';
import { toB64u } from '../src/util/bytes.js';
import { MemoryKV } from '../src/store/kv.js';
import { newIdentity } from './helpers.js';
import { FakeBroker, FakeLink, until } from './fakes.js';

const models = [];
test.afterEach(() => models.splice(0).forEach((m) => m.stop()));

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

/** Link a new device `alias` to `main` by the real flow; resolves to the reloaded device. */
async function linkPhone(main, alias, broker) {
  const [id, kv] = [await newIdentity(), new MemoryKV()];
  const first = await open(id, kv, '', broker);
  const { code, read } = await first.startLinking(alias);
  await (await read((await main.linkDevice(code)).code)).apply();
  return { phone: await open(await applyDelegation(id, kv), kv, '', broker), pub: toB64u(id.pub) };
}

/** Ada's original device and two phones, no chat room anywhere: they meet in the channel only. */
async function three() {
  const broker = new FakeBroker();
  const mainId = await newIdentity();
  const main = await open(mainId, new MemoryKV(), 'Ada', broker);
  const [one, two] = [await linkPhone(main, 'One', broker), await linkPhone(main, 'Two', broker)];
  await until(() => [main, one.phone, two.phone].every((m) => m.deviceRows().length === 3));
  return { broker, main, mainId, one, two };
}

test('after a removal the devices that are left still meet in the channel', async () => {
  const { main, one, two } = await three();
  const secret = main.sync.value(CHANNEL);
  await main.unlinkDevice(two.pub);
  assert.equal(main.sync.value(CHANNEL), secret, 'the secret stays: a device that was away finds us');
  await main.updateSettings({ name: 'Ada 2' }); // no chat room: only the channel carries it
  await until(() => one.phone.settings.name === 'Ada 2');
});

test('after a restart the withdrawn device is refused in the channel again', async () => {
  const { broker, main, mainId, one, two } = await three();
  await main.unlinkDevice(two.pub);
  const member = main.identity.member;
  assert.equal(main.deviceChannel.isWithdrawn({ d: two.pub }, member), true);
  // a room made after the removal never saw its unlink, and still refuses that device
  const club = await main.addRoom(newRoomSecret(), 'Club');
  assert.equal(club.isWithdrawn({ d: two.pub }, member), true, 'a new room');
  const { kv } = main;
  main.stop();
  const again = await open(mainId, kv, 'Ada', broker);
  assert.ok(again.deviceChannel, 'the channel is open again');
  assert.equal(again.deviceChannel.isWithdrawn({ d: two.pub }, member), true, 'the one removed');
  assert.equal(again.deviceChannel.isWithdrawn({ d: one.pub }, member), false, 'the one left');
  assert.equal(again.rooms.size, 1);
  for (const room of again.rooms.values()) {
    assert.equal(room.isWithdrawn({ d: two.pub }, member), true, `${room.label} after a restart`);
  }
});
