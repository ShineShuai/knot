// Coming back from the background: the page reconnects at once; Settings take effect without a
// reload; a message stamped ahead of this clock does not hide the ones that follow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newRoomSecret } from '../src/crypto/room-keys.js';
import { ReadMarks } from '../src/chat/read-marks.js';
import { MemoryKV } from '../src/store/kv.js';
import { watchWake } from '../src/wake.js';
import { FakeBroker, until } from './fakes.js';
import { makeRoom, stopRooms } from './room-kit.js';

test.afterEach(stopRooms);

/** A window and a document that only record listeners, per (host, type). */
function fakeWindow() {
  const listeners = new Map();
  const list = (name, type) => listeners.get(`${name}:${type}`) ?? [];
  const host = (name, extra = {}) => ({
    addEventListener: (type, fn) => listeners.set(`${name}:${type}`, [...list(name, type), fn]),
    removeEventListener: (type, fn) => {
      listeners.set(`${name}:${type}`, list(name, type).filter((f) => f !== fn));
    },
    ...extra,
  });
  const win = host('win', { document: host('doc', { visibilityState: 'visible' }) });
  const emit = (name, type, event) => list(name, type).forEach((fn) => fn(event));
  return { win, emit, count: () => [...listeners.values()].flat().length };
}

test('wake: a page hidden long enough wakes on return; short hides and focus do not', () => {
  const { win, emit } = fakeWindow();
  let t = 0, woke = 0;
  watchWake(() => woke++, { win, minHiddenMs: 10_000, now: () => t });
  win.document.visibilityState = 'hidden'; emit('doc', 'visibilitychange');
  t = 3000;
  win.document.visibilityState = 'visible'; emit('doc', 'visibilitychange');
  assert.equal(woke, 0, 'three seconds away is nothing');
  win.document.visibilityState = 'hidden'; emit('doc', 'visibilitychange');
  t = 60_000;
  win.document.visibilityState = 'visible'; emit('doc', 'visibilitychange');
  assert.equal(woke, 1);
  emit('win', 'online');
  assert.equal(woke, 2, 'the network is back');
  emit('win', 'pageshow', { persisted: false });
  assert.equal(woke, 2);
  emit('win', 'pageshow', { persisted: true });
  assert.equal(woke, 3, 'restored from the back/forward cache');
});

test('wake: stopping removes every listener', () => {
  const { win, count } = fakeWindow();
  const stop = watchWake(() => {}, { win });
  assert.ok(count() > 0);
  stop();
  assert.equal(count(), 0);
});

test('wake: the room drops its broker sockets and connects again at once', async () => {
  const broker = new FakeBroker();
  const room = await makeRoom({ broker });
  const seen = [];
  room.on('brokers', (s) => seen.push(s.connected));
  room.start();
  await until(() => room.brokerStatus?.connected === 1);
  room.wake();
  await until(() => seen.includes(0) && room.brokerStatus.connected === 1, 4000);
});

test('Settings: turning the brokers on reaches a room that is already running', async () => {
  const broker = new FakeBroker();
  const secret = newRoomSecret();
  const a = await makeRoom({ secret, name: 'Ada', broker, extra: { brokersEnabled: false } });
  const b = await makeRoom({ secret, name: 'Bob', broker });
  a.start(); b.start();
  assert.ok(!a.brokerStatus);
  a.settings.brokersEnabled = true; // what the Settings dialog does
  await a.refreshBrokers();
  const direct = (r) => r.peerList.some((p) => p.state === 'p2p');
  await until(() => direct(a) && direct(b));
  a.settings.brokersEnabled = false;
  await a.refreshBrokers();
  assert.ok(!a.brokerStatus, 'off again');
});

test('unread: a message stamped ahead of the clock is read, hiding no later one', async () => {
  const now = Date.now();
  const list = [{ id: 'x-1', kind: 'text', ms: now - 1000, c: 0 }];
  const log = { list: () => list, where: (fn) => list.filter(fn) };
  const marks = new ReadMarks({ kv: new MemoryKV(), roomId: 'r', log, isMine: () => false });
  await marks.load();
  list.push({ id: 'a-2-bob', kind: 'text', ms: now + 5 * 60_000, c: 0 }); // a fast clock
  assert.equal(marks.count, 1);
  await marks.markRead();
  assert.equal(marks.count, 0, 'seen');
  assert.ok(marks.stamp.ms <= Date.now(), 'the mark stays at our clock');
  list.splice(1, 0, { id: 'a-3-cat', kind: 'text', ms: Date.now() + 1, c: 0 });
  assert.equal(marks.count, 1, 'a real new message still counts');
  await marks.advance({ ms: now + 9 * 60_000, c: 0 }); // another device claims to be far ahead
  assert.ok(marks.stamp.ms <= Date.now());
});
