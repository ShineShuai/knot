// DeviceSeen: the rules for what we know of when our devices were online, with no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceSeen } from '../src/chat/device-seen.js';
import { MAX_FUTURE_MS } from '../src/util/hlc.js';

const [OWN, A, B] = ['own'.padEnd(43, 'x'), 'a'.padEnd(43, 'x'), 'b'.padEnd(43, 'x')];
const clock = (start = 1_000_000) => {
  const c = { now: start, read: () => c.now };
  return c;
};

test('a time is kept, never moves back, and is never later than the allowed lead', () => {
  const c = clock();
  const s = new DeviceSeen(OWN, c.read);
  assert.equal(s.note(A, 500_000), true);
  assert.equal(s.get(A).ms, 500_000);
  assert.equal(s.note(A, 400_000), false, 'older: ignored');
  assert.equal(s.get(A).ms, 500_000);
  assert.equal(s.note(A, c.now + 5 * MAX_FUTURE_MS), true);
  assert.equal(s.get(A).ms, c.now + MAX_FUTURE_MS, 'a clock that runs ahead is cut');
  assert.equal(s.note(OWN, 1), false, 'this device is never listed');
  assert.equal(s.note(B, NaN), false);
  assert.equal(s.note('', 1), false);
  assert.equal(s.get(OWN), undefined);
});

test('direct says where the current time came from: first-hand or reported', () => {
  const s = new DeviceSeen(OWN, clock().read);
  s.note(A, 100, { direct: true });
  assert.equal(s.get(A).direct, true);
  s.note(A, 200); // another device says it was seen later
  assert.deepEqual([s.get(A).ms, s.get(A).direct], [200, false]);
  s.note(A, 200, { direct: true }); // and now we saw it at that time too
  assert.equal(s.get(A).direct, true);
  s.note(A, 150, { direct: true });
  assert.equal(s.get(A).ms, 200, 'an older first-hand time does not replace a later one');
});

test('a device\'s own protocol level wins over what others say, and fills a gap', () => {
  const s = new DeviceSeen(OWN, clock().read);
  s.note(A, 100, { pv: 4 }); // hearsay, but nothing else yet
  assert.equal(s.get(A).pv, 4);
  s.note(A, 100, { pv: 5, direct: true }); // its own word
  assert.equal(s.get(A).pv, 5);
  s.note(A, 100, { pv: 9 }); // hearsay again: ignored
  assert.equal(s.get(A).pv, 5);
  s.note(B, 100, { direct: true });
  s.note(B, 100, { pv: 7 });
  assert.equal(s.get(B).pv, 7, 'no first-hand level: the report fills it');
});

test('what another device says: its own entry is first-hand, only known devices count', () => {
  const s = new DeviceSeen(OWN, clock().read);
  const known = new Set([A, B]);
  const unknown = 'z'.padEnd(43, 'x');
  const changed = s.receive({
    [A]: { ms: 300, pv: 5 }, [B]: { ms: 200, pv: 5 }, [unknown]: { ms: 1 }, [OWN]: { ms: 1 },
    bad: null, worse: { ms: 'soon' },
  }, A, known);
  assert.equal(changed, true);
  assert.deepEqual(s.get(A), { ms: 300, pv: 5, direct: true }, 'A spoke for itself');
  assert.deepEqual(s.get(B), { ms: 200, pv: 5, direct: false }, 'B by hearsay');
  assert.equal(s.get(unknown), undefined);
  assert.equal(s.get(OWN), undefined);
  assert.equal(s.receive({ [A]: { ms: 300, pv: 5 } }, A, known), false, 'nothing new');
  for (const junk of [null, undefined, 'x', 3, [1, 2]]) assert.equal(s.receive(junk, A, known), false);
});

test('at most 64 entries of a message are read', () => {
  const s = new DeviceSeen(OWN, clock().read);
  const keys = Array.from({ length: 100 }, (_, i) => String(i).padStart(43, 'k'));
  const seen = Object.fromEntries(keys.map((k) => [k, { ms: 5 }]));
  s.receive(seen, null, new Set(keys));
  assert.equal(keys.filter((k) => s.get(k)).length, 64);
});

test('the frame starts with this device and carries what we know, and round-trips', () => {
  const c = clock(777);
  const s = new DeviceSeen(OWN, c.read);
  s.note(A, 100, { pv: 5, direct: true });
  s.note(B, 90);
  const frame = s.frame(6);
  assert.deepEqual(Object.keys(frame), [OWN, A, B]);
  assert.deepEqual(frame[OWN], { ms: 777, pv: 6 });
  assert.deepEqual(frame[A], { ms: 100, pv: 5 });
  assert.deepEqual(frame[B], { ms: 90 }, 'no level to tell');
  const other = new DeviceSeen(A, clock().read); // another device of ours hears it
  other.receive(JSON.parse(JSON.stringify(frame)), OWN, new Set([OWN, B]));
  assert.deepEqual(other.get(OWN), { ms: 777, pv: 6, direct: true });
  assert.deepEqual(other.get(B), { ms: 90, pv: null, direct: false });
});

test('state is saved and loaded, and garbage is dropped on loading', () => {
  const c = clock(50);
  const s = new DeviceSeen(OWN, c.read);
  s.note(A, 10, { pv: 5, direct: true });
  s.noteSynced(A);
  assert.equal(s.syncedAt(A), 50);
  assert.equal(s.syncedAt(B), null);
  assert.equal(s.noteSynced(OWN), false);
  const copy = new DeviceSeen(OWN, c.read);
  copy.load(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(copy.get(A), { ms: 10, pv: 5, direct: true });
  assert.equal(copy.syncedAt(A), 50);
  const messy = new DeviceSeen(OWN, c.read);
  messy.load({ seen: { [A]: { ms: 'x' }, [B]: null, ok: { ms: 3 } }, synced: { [A]: 'y', [B]: 4 } });
  assert.equal(messy.get(A), undefined);
  assert.equal(messy.get(B), undefined);
  assert.deepEqual(messy.get('ok'), { ms: 3, pv: null, direct: false });
  assert.equal(messy.syncedAt(A), null);
  assert.equal(messy.syncedAt(B), 4);
  messy.load(undefined);
  messy.load('nonsense');
});
