import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LADDER, LinkQuality, bitrate, ceiling, parseWant, profileOf, readStats, rungByPeople, rungFor,
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
    bytes: 1000, ts: 5, fps: null, w: null, h: null, loss: 0.02, rtt: 0.08, limit: 'cpu',
    available: 7e5, recv: null,
  });
  assert.deepEqual(readStats({ forEach() {} }), {
    bytes: null, ts: null, fps: null, w: null, h: null, loss: null, rtt: null, limit: null,
    available: null, recv: null,
  });
  const more = [
    { type: 'outbound-rtp', kind: 'video', framesPerSecond: 29, frameWidth: 640, frameHeight: 360 },
    { type: 'inbound-rtp', kind: 'video', framesPerSecond: 24, frameWidth: 320, frameHeight: 180,
      freezeCount: 2 },
    { type: 'inbound-rtp', kind: 'audio', framesPerSecond: 99 },
  ];
  const got = readStats({ forEach: (fn) => more.forEach(fn) });
  assert.deepEqual([got.fps, got.w, got.h], [29, 640, 360]);
  assert.deepEqual(got.recv, { fps: 24, w: 320, h: 180, freezes: 2 });
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
  const tight = { ...good, available: 270_000 }; // no air above the 250k rung
  assert.equal(run(q, tight, 5, 12_000, 60_000), 2);
  const some = { ...good, available: 400_000 }; // air to try 500k, none beyond
  assert.equal(run(q, some, 5, 62_000, 120_000), 3);
  const roomy = { ...good, available: 2_000_000 }; // a wide margin: no need to wait
  assert.equal(q.update(roomy, 5, 122_000), 4);
  assert.equal(q.update(roomy, 5, 126_000), 4); // the margin above 1M is thinner: wait again
});

test('a rung that did not hold is not tried again for a while, longer each time', () => {
  const q = new LinkQuality('camera', 0);
  assert.equal(run(q, good, 5, 2000, 10_000), 4); // the climb
  const lossy = { loss: 0.08, rtt: 0.05 };
  q.update(lossy, 5, 12_000);
  assert.equal(q.update(lossy, 5, 14_000), 3); // it did not hold
  assert.equal(run(q, good, 5, 16_000, 100_000), 3); // 8 s of calm would have been enough
  assert.equal(q.update(good, 5, 106_000), 4); // tried again once the block ended
  q.update(lossy, 5, 108_000);
  assert.equal(q.update(lossy, 5, 110_000), 3); // and failed again: now the block is doubled
  assert.equal(run(q, good, 5, 112_000, 280_000), 3);
  assert.equal(q.update(good, 5, 292_000), 4);
});

test('a wide margin in the estimate overrides the block on a failed rung', () => {
  const q = new LinkQuality('camera', 0);
  run(q, good, 5, 2000, 10_000);
  const lossy = { loss: 0.08, rtt: 0.05 };
  q.update(lossy, 5, 12_000);
  assert.equal(q.update(lossy, 5, 14_000), 3);
  assert.equal(run(q, { ...good, available: 3_000_000 }, 5, 16_000, 20_000), 4);
});

test('a rung that held for a minute is trusted again: its next failure counts as the first', () => {
  const q = new LinkQuality('camera', 0);
  const lossy = { loss: 0.08, rtt: 0.05 };
  assert.equal(run(q, good, 4, 2000, 10_000), 4);
  q.update(lossy, 4, 12_000);
  assert.equal(q.update(lossy, 4, 14_000), 3); // 4 failed right after the climb: 90 s block
  assert.equal(run(q, good, 4, 16_000, 102_000), 3);
  assert.equal(q.update(good, 4, 104_000), 4); // tried again, and it holds
  run(q, good, 4, 106_000, 168_000);
  q.update(lossy, 4, 170_000);
  assert.equal(q.update(lossy, 4, 172_000), 3);
  assert.equal(run(q, good, 4, 174_000, 214_000), 3); // blocked for 45 s, not 90 or 180
  assert.equal(q.update(good, 4, 218_000), 4);
});

test('video that cannot be carried is dropped, and tried again after a pause', () => {
  const q = new LinkQuality('camera', 0);
  assert.equal(q.update({ loss: 0.4, rtt: 0.05 }, 5, 4000), 1);
  assert.equal(q.update({ loss: 0.4, rtt: 0.05 }, 5, 8000), 0);
  assert.equal(q.update(good, 5, 12_000), 0); // paused: no video to measure
  assert.equal(q.update(good, 5, 22_000), 0);
  assert.equal(q.update(good, 5, 24_000), 1); // tries the lowest rung again
});

test('bitrate comes from byte counts and their timestamps, or from a given interval', () => {
  assert.equal(bitrate({ bytes: 1000, ts: 0 }, { bytes: 26_000, ts: 2000 }), 100_000);
  assert.equal(bitrate({ bytes: 1000 }, { bytes: 26_000 }, 2), 100_000);
  assert.equal(bitrate({ bytes: 5000, ts: 0 }, { bytes: 1000, ts: 1000 }), 0); // a restart
  assert.equal(bitrate(null, { bytes: 1 }, 2), null);
  assert.equal(bitrate({ bytes: 1 }, { bytes: null }, 2), null);
  assert.equal(bitrate({ bytes: 1 }, { bytes: 9 }), null); // no time given
});
