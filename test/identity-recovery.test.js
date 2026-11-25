// The recovery code: a recovery key that the main key authorized signs certificates for new
// devices, so an identity outlives the main device's key. Forgery, the code, rooms and the app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AppModel } from '../src/app.js';
import { authorIdOf, createEnvelope, verifyEnvelope } from '../src/chat/envelope.js';
import { DEFAULTS } from '../src/config.js';
import {
  applyDelegation, certShape, makeChainCert, makeCert, makeRecoveryCert, verifyCert,
  verifyRecoveryCert,
} from '../src/crypto/delegation.js';
import {
  RecoveryError, certifyDevice, makeRecoveryCode, readRecoveryCode,
} from '../src/crypto/identity-recovery.js';
import { newRoomSecret } from '../src/crypto/room-keys.js';
import { CHANNEL } from '../src/chat/device-sync.js';
import { MemoryKV } from '../src/store/kv.js';
import { fromB64u, toB64u } from '../src/util/bytes.js';
import { HLC } from '../src/util/hlc.js';
import { newIdentity } from './helpers.js';
import { until } from './fakes.js';
import { link, makeRoom, stopRooms, texts } from './room-kit.js';

test.afterEach(stopRooms);
const FAST = { iterations: 1000 };
const PASS = 'long enough';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rejects = (promise, code) => assert.rejects(
  promise, (e) => e instanceof RecoveryError && e.code === code,
);

/** main, its recovery key, the recovery certificate and a device certified through them. */
async function chain(name = 'Phone') {
  const [main, q, device] = [await newIdentity(), await newIdentity(), await newIdentity()];
  const rc = await makeRecoveryCert(main, q.pub);
  const cert = await makeChainCert(q, rc, device.pub, name);
  return { main, q, device, rc, cert };
}

test('a device certified through a recovery key speaks for the main identity', async () => {
  const { main, rc, cert } = await chain();
  assert.equal(await verifyRecoveryCert(rc), true);
  assert.equal(certShape(cert), true);
  assert.equal(await verifyCert(cert), main.id);
  assert.equal(cert.r, toB64u(main.pub), 'named after the main key, not the recovery key');
});

test('forged chains are refused: every part of both certificates is signed', async () => {
  const { main, q, device, rc, cert } = await chain();
  const other = await newIdentity();
  const flip = (s) => `${s[0] === 'A' ? 'B' : 'A'}${s.slice(1)}`;
  const forged = {
    'recovery signature': { ...cert, up: { ...rc, sig: flip(rc.sig) } },
    'another recovery key': { ...cert, up: { ...rc, q: toB64u(other.pub) } },
    'recovery time': { ...cert, up: { ...rc, ms: rc.ms + 1 } },
    'device signature': { ...cert, sig: flip(cert.sig) },
    'device key': { ...cert, d: toB64u(other.pub) },
    'device name': { ...cert, n: 'Mallory' },
    'main key': { ...cert, r: toB64u(other.pub), up: { ...rc, r: toB64u(other.pub) } },
    'chain of another main': { ...cert, up: { ...rc, r: toB64u(other.pub) } },
    'signed by the main key, not the recovery key': {
      ...await makeCert(main, device.pub, 'Phone'), up: rc,
    },
    'a recovery key that nobody authorized': {
      ...await makeChainCert(other, { ...rc, q: toB64u(other.pub) }, device.pub, 'Phone'),
    },
  };
  for (const [what, bad] of Object.entries(forged)) {
    assert.equal(await verifyCert(bad), null, what);
  }
  const deeper = { ...cert, up: { ...rc, up: rc } }; // one hop only
  assert.equal(certShape(deeper), false);
  const asRecovery = await makeCert(main, q.pub, 'x'); // a device certificate is no recovery one
  assert.equal(await verifyRecoveryCert({ ...asRecovery, q: asRecovery.d }), false);
});

test('the code: the passphrase opens it and nothing else does', async () => {
  const main = await newIdentity();
  const channel = toB64u(newRoomSecret());
  const { code, q } = await makeRecoveryCode(main, PASS, { channel, ...FAST });
  assert.match(code, /^knot-ik1-[A-Za-z0-9_-]+$/);
  const found = await readRecoveryCode(code, PASS);
  assert.equal(found.member, main.id);
  assert.equal(found.channel, channel);
  assert.equal(found.rc.q, q);
  assert.equal(toB64u(found.recovery.pub), q);
  assert.equal(await verifyRecoveryCert(found.rc), true);

  await rejects(readRecoveryCode(code, 'wrong passphrase'), 'wrong_passphrase');
  await rejects(readRecoveryCode(code, ''), 'empty_passphrase');
  await rejects(readRecoveryCode('hello', PASS), 'not_a_code');
  await rejects(readRecoveryCode(code.slice(0, 40), PASS), 'not_a_code');
  const at = code.length - 5;
  const flipped = `${code.slice(0, at)}${code[at] === 'A' ? 'B' : 'A'}${code.slice(at + 1)}`;
  await rejects(readRecoveryCode(flipped, PASS), 'wrong_passphrase');
  const spaced = `my code:\n${code.slice(0, 50)}\n  ${code.slice(50, 120)} ${code.slice(120)}\n`;
  assert.equal((await readRecoveryCode(spaced, PASS)).member, main.id, 'pasted with breaks');
  await rejects(makeRecoveryCode(main, 'short', FAST), 'short_passphrase');
  await rejects(makeRecoveryCode(main, PASS, { channel: 'x', ...FAST }), 'damaged');
  const wire = fromB64u(code.slice('knot-ik1-'.length));
  const edit = (change) => `knot-ik1-${toB64u(change(Uint8Array.from(wire)))}`;
  await rejects(readRecoveryCode(edit((b) => { b[0] = 9; return b; }), PASS), 'newer');
  await rejects(readRecoveryCode(edit((b) => { b.set([255, 255, 255, 255], 1); return b; }), PASS),
    'damaged'); // a crafted number of rounds must not make us work for ever
});

test('two codes of one identity are independent; a code without a channel says so', async () => {
  const main = await newIdentity();
  const one = await makeRecoveryCode(main, PASS, FAST);
  const two = await makeRecoveryCode(main, PASS, FAST);
  assert.notEqual(one.q, two.q);
  assert.equal((await readRecoveryCode(one.code, PASS)).channel, null);
});

test('envelopes of a restored device are valid and written as the main identity', async () => {
  const { main, device, cert } = await chain();
  Object.assign(device, { member: main.id, cert });
  const room = toB64u(newRoomSecret()).slice(0, 16);
  const env = await createEnvelope(device, new HLC(), room, 'text', 'back again', 'Ada');
  assert.equal(await verifyEnvelope(env, room), true);
  assert.equal(authorIdOf(env), main.id);
  const broken = { ...cert, sig: `${cert.sig[0] === 'A' ? 'B' : 'A'}${cert.sig.slice(1)}` };
  assert.equal(await verifyEnvelope({ ...env, cert: broken }, room), false);
});

/** Ada's main device `a`, her restored device `b` (certified through a recovery key), Bob. */
async function trio() {
  const secret = newRoomSecret();
  const { main, device, rc, cert } = await chain();
  Object.assign(device, { member: main.id, cert });
  const a = await makeRoom({ secret, name: 'Ada', identity: main });
  const b = await makeRoom({ secret, name: 'Ada', identity: device });
  const bob = await makeRoom({ secret, name: 'Bob' });
  await link(a, bob);
  await link(b, bob);
  return { a, b, bob, main, device, rc, cert };
}

test('in a room: a restored device is accepted until its recovery key is withdrawn', async () => {
  const { a, b, bob, device, rc } = await trio();
  await b.sendText('from the restored device');
  await until(() => texts(bob).includes('from the restored device'));
  let told = 0;
  b.on('unlinked', () => told++);
  await a.unlinkDevice(rc.q); // the recovery key, not the device
  await until(() => bob.log.where((e) => e.kind === 'unlink').length === 1);
  await until(() => told === 1);
  await assert.rejects(b.sendText('still here?'), /unlinked/);
  const late = await createEnvelope(device, new HLC(), b.id, 'text', 'late', 'Ada');
  [...bob.peers.values()][0].link.peer.emit('chat', JSON.stringify({ t: 'msg', e: late }));
  await wait(60);
  assert.equal(texts(bob).includes('late'), false, 'refused wherever the withdrawal is known');
  await a.sendText('the main device is untouched');
  await until(() => texts(bob).includes('the main device is untouched'));
});

test('in a room: the device itself can be withdrawn too, as any linked device', async () => {
  const { a, b, bob, cert } = await trio();
  await b.sendText('hello'); // the links are working before the news has to travel
  await until(() => texts(bob).includes('hello'));
  let told = 0;
  b.on('unlinked', () => told++);
  await a.unlinkDevice(cert.d);
  await until(() => told >= 1);
  assert.equal(a.isWithdrawn(cert, await verifyCert(cert)), true);
  await assert.rejects(b.sendText('x'), /unlinked/);
  assert.equal(texts(bob).includes('x'), false);
});

// ---- the app ---------------------------------------------------------------------------

const settings = { ...DEFAULTS, brokersEnabled: false, brokers: [] };
const modelOf = async (kv = new MemoryKV(), identity) => {
  const m = new AppModel({
    kv, identity: identity ?? await newIdentity(), settings, iceServers: () => [],
  });
  await m.load();
  return m;
};

test('app: a code made on the main device lets a wiped device restore the identity', async () => {
  const main = await modelOf();
  const room = await main.createRoom('Club');
  const code = await main.makeRecoveryCode(PASS, FAST);
  const info = await main.recoveryInfo();
  assert.equal(info.channel, false);
  assert.match(code, /^knot-ik1-/);

  const [kv, own] = [new MemoryKV(), await newIdentity()]; // the wiped device, a new key
  const wiped = await modelOf(kv, own);
  await assert.rejects(wiped.restoreIdentity(code, 'not it'), /wrong_passphrase/);
  assert.equal(await kv.get('delegate'), undefined, 'a wrong passphrase changes nothing');
  const done = await wiped.restoreIdentity(code, PASS);
  assert.equal(done.member, main.identity.member);

  await applyDelegation(own, kv); // what the next start does
  const back = await modelOf(kv, own);
  assert.equal(back.isLinked, true);
  assert.equal(back.identity.member, main.identity.member, 'the old identity, same id');
  assert.equal(await verifyCert(back.identity.cert), main.identity.member);
  assert.equal(back.identity.cert.up.q, info.q);
  assert.equal(back.sync.value(CHANNEL), undefined, 'no channel was in this code');
  room.stop();
});

test('app: a code with the channel gives the restored device the way to its others', async () => {
  const mainKey = await newIdentity();
  const channel = toB64u(newRoomSecret());
  const { code } = await makeRecoveryCode(mainKey, PASS, { channel, ...FAST });
  const [kv, own] = [new MemoryKV(), await newIdentity()];
  await (await modelOf(kv, own)).restoreIdentity(code, PASS);
  await applyDelegation(own, kv);
  const back = await modelOf(kv, own);
  assert.equal(back.sync.value(CHANNEL), channel);
  assert.equal(back.paired, true, 'a linked device is always paired');
  assert.ok(back.deviceRows().some((r) => r.self), 'it is in its own device list');
  back.stop();
});

test('app: restore refuses a linked device and one that owns rooms or has links', async () => {
  const mainKey = await newIdentity();
  const { code } = await makeRecoveryCode(mainKey, PASS, FAST);

  const owner = await modelOf();
  const room = await owner.createRoom('Mine');
  await rejects(owner.restoreIdentity(code, PASS), 'owns_rooms');
  room.stop();

  const [kv, own] = [new MemoryKV(), await newIdentity()];
  await (await modelOf(kv, own)).restoreIdentity(code, PASS);
  await applyDelegation(own, kv);
  const linked = await modelOf(kv, own);
  await assert.rejects(linked.restoreIdentity(code, PASS), /already linked/);
  await assert.rejects(linked.makeRecoveryCode(PASS, FAST), /Only the main device/);
});

test('app: a new code withdraws the old key; cancelling withdraws the current one', async () => {
  const main = await modelOf();
  const room = await main.createRoom('Club');
  const member = main.identity.member;
  const first = await main.makeRecoveryCode(PASS, FAST);
  const certFor = async (code) => certifyDevice(
    await readRecoveryCode(code, PASS), (await newIdentity()).pub, 'Phone',
  );
  const oldCert = await certFor(first);
  assert.equal(room.isWithdrawn(oldCert, member), false);

  const second = await main.makeRecoveryCode(PASS, FAST);
  assert.equal(room.isWithdrawn(oldCert, member), true, 'the old code is dead');
  const newCert = await certFor(second);
  assert.equal(room.isWithdrawn(newCert, member), false);
  assert.equal((await main.recoveryInfo()).q, newCert.up.q);

  await main.cancelRecovery();
  assert.equal(await main.recoveryInfo(), null);
  assert.equal(room.isWithdrawn(newCert, member), true);
  await main.cancelRecovery(); // nothing to cancel is no error
  room.stop();
});

// ---- the notice: a device that joined with the code is shown, once ---------------------------

test('a room tells when a device of ours with a recovery certificate connects', async () => {
  const { a, b } = await trio();
  const seen = { a: [], b: [] };
  a.on('sibling', (entry) => seen.a.push(entry));
  b.on('sibling', (entry) => seen.b.push(entry));
  await link(a, b); // two devices of one identity, in one room
  await until(() => seen.a.length && seen.b.length);
  assert.equal(!!seen.a[0].cert.up, true, 'the main sees a device that came through the code');
  assert.equal(seen.b[0].cert, undefined, 'the restored device sees the main: no chain');
});

/** A model with a room, and the event the room raises when a restored device connects. */
async function noticing() {
  const kv = new MemoryKV();
  const identity = await newIdentity();
  const model = await modelOf(kv, identity);
  const room = await model.createRoom('Club');
  const { device, cert } = await chain('Mac');
  const entry = { cert, pub: device.pub, member: identity.member, sibling: true };
  return { kv, identity, model, room, cert, entry };
}

test('app: a restored device is noticed once and the notice survives a reload', async () => {
  const { kv, identity, model, room, cert, entry } = await noticing();
  let told = 0;
  model.on('restored', () => told++);
  room.emit('sibling', entry);
  await until(() => model.restoredNotices.length === 1);
  assert.equal(model.restoredNotices[0].name, 'Mac');
  assert.equal(model.restoredNotices[0].q, cert.up.q);
  room.emit('sibling', entry); // the same device again: no second notice
  await wait(20);
  assert.equal(model.restoredNotices.length, 1);
  assert.equal(told, 1);

  const ownRoom = (await newIdentity()).pub;
  room.emit('sibling', { ...entry, cert: { ...cert, up: undefined, d: toB64u(ownRoom) } });
  await wait(20);
  assert.equal(model.restoredNotices.length, 1, 'a device without a recovery key is no notice');

  const again = await modelOf(kv, identity); // the page is reloaded
  assert.equal(again.restoredNotices.length, 1, 'still unacknowledged');
  await again.dismissRestored();
  assert.equal(again.restoredNotices.length, 0);
  assert.equal(again.restoredDevices().length, 1, 'but still known');
  assert.equal((await modelOf(kv, identity)).restoredNotices.length, 0, 'and it stays so');
  room.stop();
});

test('app: any device can cancel the code a restored device joined with', async () => {
  const { model, room, cert, entry } = await noticing();
  room.emit('sibling', entry);
  await until(() => model.restoredNotices.length === 1);
  const member = model.identity.member;
  assert.equal(room.isWithdrawn(cert, member), false);
  await model.cancelRecovery(cert.up.q); // no main-device record is needed
  assert.equal(room.isWithdrawn(cert, member), true);
  assert.equal(model.restoredDevices().length, 0);
  room.stop();
});

test('app: the notice goes away when that device is unlinked', async () => {
  const { model, room, cert, entry } = await noticing();
  room.emit('sibling', entry);
  await until(() => model.restoredDevices().length === 1);
  const row = model.deviceRows().find((r) => r.pub === cert.d);
  assert.equal(row.restored, true, 'in the device list before its alias has arrived');
  assert.equal(row.alias, 'Mac');
  await model.unlinkDevice(cert.d);
  assert.equal(model.restoredDevices().length, 0);
  assert.equal(room.isWithdrawn(cert, model.identity.member), true);
  room.stop();
});
