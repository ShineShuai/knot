import test from 'node:test';
import assert from 'node:assert/strict';
import { ByteReader, ByteWriter, fromB64u, toB64u } from '../src/util/bytes.js';
import { HLC } from '../src/util/hlc.js';
import { RateLimiter } from '../src/util/rate.js';

test('base64url round-trips all byte values', () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual(fromB64u(toB64u(all)), all);
  assert.match(toB64u(all), /^[A-Za-z0-9_-]+$/);
});

test('ByteWriter/ByteReader round-trip and bounds', () => {
  const bytes = new ByteWriter().u8(7).u16(513).u32(0xdeadbeef).str('héllo').done();
  const r = new ByteReader(bytes);
  assert.deepEqual([r.u8(), r.u16(), r.u32(), r.str()], [7, 513, 0xdeadbeef, 'héllo']);
  assert.throws(() => r.u8(), /truncated/);
  assert.throws(() => new ByteWriter().lp(new Uint8Array(256)), RangeError);
});

test('HLC is monotonic even when the wall clock stalls or goes back', () => {
  let t = 1000;
  const hlc = new HLC(() => t);
  const a = hlc.tick(); const b = hlc.tick(); t = 900; const c = hlc.tick();
  assert.deepEqual([a.ms, a.c, b.c, c.ms, c.c], [1000, 0, 1, 1000, 2]);
});

test('HLC.observe merges remote stamps and clamps far-future ones', () => {
  let t = 1000;
  const hlc = new HLC(() => t);
  hlc.observe({ ms: 1500, c: 4 });
  assert.deepEqual([hlc.ms, hlc.c], [1500, 5]);
  hlc.observe({ ms: 9e15, c: 0 });
  assert.ok(hlc.ms <= t + 10 * 60 * 1000);
});

test('RateLimiter allows a burst then refills', () => {
  let t = 0;
  const rl = new RateLimiter(5, () => t);
  assert.equal([1, 2, 3, 4, 5, 6].filter(() => rl.allow()).length, 5);
  t += 1000;
  assert.ok(rl.allow());
});
