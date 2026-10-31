import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LADDER, LinkQuality, ceiling, parseWant, profileOf, readStats, rungByPeople, rungFor,
  wantHeight,
} from '../src/call/quality.js';

test('the ladders rise in height, frame rate and bitrate', () => {
  for (const ladder of Object.values(LADDER)) {
    assert.equal(ladder[0], null);
    for (let i = 2; i < ladder.length; i++) {
      assert.ok(ladder[i].h >= ladder[i - 1].h && ladder[i].fps >= ladder[i - 1].fps);
      assert.ok(ladder[i].bps > ladder[i - 1].bps);
    }
  }
});

test('more people, lower ceiling; the receiver\'s tile lowers it further', () => {
  assert.deepEqual([2, 3, 4, 5, 6].map((n) => rungByPeople('camera', n)), [5, 4, 3, 2, 2]);
  assert.deepEqual([2, 3, 4, 5, 6].map((n) => rungByPeople('screen', n)), [4, 3, 2, 1, 1]);
  assert.equal(ceiling('camera', 2, undefined), 5); // not told yet: the head count decides
  assert.equal(ceiling('camera', 2, 0), 0);
  assert.equal(ceiling('camera', 2, 180), 1);
  assert.equal(ceiling('camera', 2, 360), 3);
  assert.equal(ceiling('camera', 2, 4000), 5);
  assert.equal(ceiling('camera', 6, 1080), 2);
  assert.equal(ceiling('screen', 2, 1080), 4); // the top rung, not the first 1080p one
});

test('rungFor picks the smallest rung that is tall enough', () => {
  assert.equal(rungFor('camera', 0), 0);
  assert.equal(rungFor('camera', 181), 2);
  assert.equal(rungFor('screen', 100), 1);
});

test('profiles: off is just off; a screen keeps its sharpness', () => {
  assert.deepEqual(profileOf('camera', 0), { active: false, kind: 'camera' });
  assert.deepEqual(profileOf('screen', 3), {
    active: true, kind: 'screen', h: 1080, fps: 10, bps: 1_000_000,
  });
});

test('tile sizes become requests in steps; a collapsed tile asks for nothing', () => {
  assert.equal(wantHeight(0), 0);
  assert.equal(wantHeight(1), 0);
  assert.equal(wantHeight(150, 1), 180);
  assert.equal(wantHeight(150, 2), 360);
  assert.equal(wantHeight(500, 2), 1080);
  assert.equal(wantHeight(5000, 3), 1080);
  assert.equal(wantHeight(200, 0), 270); // a nonsense ratio counts as 1
});

test('only whole, sane heights are believed', () => {
  assert.equal(parseWant(0), 0);
  assert.equal(parseWant(360), 360);
  for (const bad of [-1, 360.5, 5000, '360', null, undefined, NaN]) {
    assert.equal(parseWant(bad), undefined);
  }
});

test('readStats keeps what browsers give and tolerates what they do not', () => {
  const list = [
    { type: 'outbound-rtp', kind: 'audio', bytesSent: 9 },
    {
      type: 'outbound-rtp', kind: 'video', bytesSent: 1000, timestamp: 5,
      qualityLimitationReason: 'cpu',
    },
    { type: 'remote-inbound-rtp', kind: 'video', fractionLost: 0.02, roundTripTime: 0.08 },
    { type: 'candidate-pair', nominated: true, state: 'succeeded', availableOutgoingBitrate: 7e5 },
    { type: 'candidate-pair', nominated: false, state: 'succeeded', availableOutgoingBitrate: 1 },
  ];
  assert.deepEqual(readStats({ forEach: (fn) => list.forEach(fn) }), {
    bytes: 1000, ts: 5, loss: 0.02, rtt: 0.08, limit: 'cpu', available: 7e5,
  });
  assert.deepEqual(readStats({ forEach() {} }), {
    bytes: null, ts: null, loss: null, rtt: null, limit: null, available: null,
  });
});

const good = { loss: 0, rtt: 0.05 };
const run = (q, sample, ceil, from, to, step = 2000) => {
  let rung;
  for (let at = from; at <= to; at += step) rung = q.update(sample, ceil, at);
  return rung;
};

test('a new connection starts steady, then climbs one rung per calm spell', () => {
  const q = new LinkQuality('camera', 0);
  assert.equal(q.rung(5), 3);
  assert.equal(run(q, good, 5, 2000, 8000), 3); // not calm for long enough yet
  assert.equal(q.update(good, 5, 10_000), 4);
  assert.equal(run(q, good, 5, 12_000, 16_000), 4);
  assert.equal(q.update(good, 5, 20_000), 5);
  assert.equal(run(q, good, 5, 22_000, 80_000), 5); // the ceiling stops it
});

test('the ceiling is never exceeded, and what was proven is remembered', () => {
  const q = new LinkQuality('camera', 0);
  run(q, good, 5, 2000, 20_000);
  assert.equal(q.level, 5);
  assert.equal(q.update(good, 2, 22_000), 2); // a small tile: send less
  assert.equal(q.update(good, 5, 24_000), 5); // big again: back at once
  assert.equal(q.update(good, 0, 26_000), 0); // hidden: nothing
  assert.equal(q.rung(0), 0);
});

test('trouble must last two samples; severe trouble acts at once and cuts deeper', () => {
  const q = new LinkQuality('camera', 0);
  const lossy = { loss: 0.08, rtt: 0.05 };
  assert.equal(q.update(lossy, 5, 4000), 3); // one bad sample: a blip
  assert.equal(q.update(good, 5, 6000), 3);
  assert.equal(q.update(lossy, 5, 8000), 3);
  assert.equal(q.update(lossy, 5, 10_000), 2); // two in a row: one rung down
  assert.equal(q.update({ loss: 0.4, rtt: 0.05 }, 5, 14_000), 0); // severe: two down
});

test('a growing queue (round-trip time) counts as trouble before packets are lost', () => {
  const q = new LinkQuality('camera', 0);
  q.update({ loss: 0, rtt: 0.04 }, 5, 2000);
  assert.equal(q.update({ loss: 0, rtt: 0.6 }, 5, 4000), 3);
  assert.equal(q.update({ loss: 0, rtt: 0.7 }, 5, 6000), 2);
});

test('the browser holding back for bandwidth or CPU means we ask too much', () => {
  for (const limit of ['bandwidth', 'cpu']) {
    const q = new LinkQuality('camera', 0);
    q.update({ ...good, limit }, 5, 4000);
    assert.equal(q.update({ ...good, limit }, 5, 6000), 2, limit);
  }
  const q = new LinkQuality('camera', 0);
  assert.equal(q.update({ ...good, limit: 'none' }, 5, 4000), 3);
});

test('the browser\'s bandwidth estimate gates both the cap and the climb', () => {
  const q = new LinkQuality('camera', 0);
  const poor = { ...good, available: 200_000 }; // 500k rung needs about 700k
  for (let at = 2000; at <= 6000; at += 2000) q.update(poor, 5, at); // still warming up
  assert.equal(q.update(poor, 5, 8000), 3);
  assert.equal(q.update(poor, 5, 10_000), 2);
  const tight = { ...good, available: 400_000 }; // fits 250k, not the next rung (needs 650k)
  assert.equal(run(q, tight, 5, 12_000, 60_000), 2);
  const roomy = { ...good, available: 900_000 };
  assert.equal(run(q, roomy, 5, 62_000, 80_000), 3);
});

test('a failed climb makes the next one wait longer', () => {
  const q = new LinkQuality('camera', 0);
  assert.equal(run(q, good, 5, 2000, 10_000), 4); // the climb
  const lossy = { loss: 0.08, rtt: 0.05 };
  q.update(lossy, 5, 12_000);
  assert.equal(q.update(lossy, 5, 14_000), 3); // it did not hold
  assert.equal(run(q, good, 5, 16_000, 28_000), 3); // 8 s would have been enough before
  assert.equal(q.update(good, 5, 32_000), 4);
});

test('video that cannot be carried is dropped, and tried again after a pause', () => {
  const q = new LinkQuality('camera', 0);
  assert.equal(q.update({ loss: 0.4, rtt: 0.05 }, 5, 4000), 1);
  assert.equal(q.update({ loss: 0.4, rtt: 0.05 }, 5, 8000), 0);
  assert.equal(q.update(good, 5, 12_000), 0); // paused: no video to measure
  assert.equal(q.update(good, 5, 22_000), 0);
  assert.equal(q.update(good, 5, 24_000), 1); // tries the lowest rung again
});
