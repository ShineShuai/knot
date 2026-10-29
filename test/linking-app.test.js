// The whole link flow through AppModel: new device asks, main device answers, rooms arrive,
// the new device restarts as a linked device, the main device unlinks it again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AppModel } from '../src/app.js';
import { DEFAULTS } from '../src/config.js';
import { applyDelegation } from '../src/crypto/delegation.js';
import { newRoomSecret } from '../src/crypto/room-keys.js';
import { MemoryKV } from '../src/store/kv.js';
import { newIdentity } from './helpers.js';

const open = async (identity, kv = new MemoryKV(), name = '') => {
  const settings = { ...DEFAULTS, name, brokersEnabled: false, brokers: [] };
  const model = new AppModel({ kv, identity, settings, iceServers: () => [] });
  await model.load();
  return model;
};
const labels = (model) => [...model.rooms.values()].map((r) => r.label).sort();

test('link a phone to the main device, then unlink it', async () => {
  const main = await open(await newIdentity(), new MemoryKV(), 'Ada');
  const owned = await main.createRoom('Owned');
  await main.addRoom(newRoomSecret(), 'Open');

  const phoneIdentity = await newIdentity();
  const phoneKv = new MemoryKV();
  const phone = await open(phoneIdentity, phoneKv);
  assert.equal(phone.isLinked, false);
  const { code, read } = await phone.startLinking('Pixel');

  const answer = await main.linkDevice(`here: ${code}`);
  assert.equal(answer.name, 'Pixel');
  const seen = await read(answer.code);
  assert.equal(seen.sas, answer.sas, 'both screens show the same digits');
  assert.equal(seen.mainId, main.identity.id);
  assert.equal(seen.rooms, 2);
  assert.equal(await read('knotdev2-nonsense'), null);
  await seen.apply();

  assert.equal(phone.settings.name, 'Ada');
  const linked = await main.linkedDevices();
  assert.deepEqual(linked.map((d) => d.n), ['Pixel']);

  // "Reload": the phone starts again from what it stored.
  const again = await open(await applyDelegation(phoneIdentity, phoneKv), phoneKv);
  assert.equal(again.isLinked, true);
  assert.equal(again.identity.member, main.identity.id);
  assert.deepEqual(labels(again), ['Open', 'Owned']);
  const copy = [...again.rooms.values()].find((r) => r.label === 'Owned');
  assert.equal(copy.ownerId, owned.ownerId, 'the owner is still the main identity');
  assert.equal(copy.isOwner, false, 'the phone can be no owner');
  await assert.rejects(again.createRoom('Mine'), /main device/);
  await assert.rejects(again.startLinking(), /already linked/);
  await assert.rejects(again.linkDevice(code), /Only the main device/);

  await main.unlinkDevice(linked[0].d);
  assert.deepEqual(await main.linkedDevices(), []);
  for (const room of main.rooms.values()) {
    assert.equal(room.log.where((e) => e.kind === 'unlink').length, 1, room.label);
  }
  main.rooms.forEach((r) => r.stop());
  again.rooms.forEach((r) => r.stop());
  phone.rooms.forEach((r) => r.stop());
});

test('a code that is not a valid device request is refused', async () => {
  const main = await open(await newIdentity());
  await assert.rejects(main.linkDevice('knotdev1-garbage'), /not a valid device code/);
  await assert.rejects(main.linkDevice(''), /not a valid device code/);
});
