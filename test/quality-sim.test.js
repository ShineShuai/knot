// The quality controller against modelled networks (see quality-sim.js for what the model is
// and is not). These pin down the behaviour that matters for a call: settle at a rung the link
// can carry, do not flap, keep the queue (delay) short, give up video only when hopeless, and
// come back after the network does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { flaps, rungAt, simulate } from './quality-sim.js';

// What the browser tells the page differs: nothing but loss and delay (Firefox, Safari), or
// also why it holds back, or also its bandwidth estimate (Chromium).
const BROWSERS = [
  { name: 'no extras', estimate: 'none', limitSignal: false },
  { name: 'limit reason', estimate: 'none', limitSignal: true },
  { name: 'app-limited estimate', estimate: 'limited', limitSignal: true },
  { name: 'probing estimate', estimate: 'probing', limitSignal: true },
];
const each = (fn) => { for (const b of BROWSERS) fn(b, `[${b.name}]`); };

test('sim: a rich link reaches the top rung and stays there', () => {
  each((b, tag) => {
    const run = simulate({ capacity: () => 10e6, ...b });
    assert.equal(rungAt(run, 45), 5, tag);
    assert.equal(rungAt(run, 170), 5, tag);
    assert.equal(flaps(run, 45), 0, tag);
    assert.equal(run.overload, 0, tag);
  });
});

test('sim: a 600 kb/s link settles on 360p, quietly, and never pauses', () => {
  each((b, tag) => {
    const run = simulate({ capacity: () => 600e3, ...b });
    assert.equal(rungAt(run, 60), 3, tag);
    assert.equal(rungAt(run, 170), 3, tag);
    assert.ok(flaps(run, 40) <= 2, `${tag} flaps ${flaps(run, 40)}`);
    assert.ok(run.overload <= 4, `${tag} overload ${run.overload}`);
    assert.equal(run.paused, 0, tag);
  });
});

test('sim: when the capacity collapses, the rung follows with a short queue', () => {
  each((b, tag) => {
    const run = simulate({ capacity: (t) => (t < 60 ? 5e6 : 300e3), seconds: 150, ...b });
    assert.equal(rungAt(run, 59), 5, tag);
    assert.ok(rungAt(run, 100) <= 2, `${tag} rung ${rungAt(run, 100)}`);
    assert.ok(run.overload <= 6, `${tag} overload ${run.overload}`);
    assert.ok(run.lossy <= 3, `${tag} lossy ${run.lossy}`);
    assert.equal(run.paused, 0, tag);
  });
});

test('sim: a hopeless link carries audio only, and video is tried rarely', () => {
  each((b, tag) => {
    const run = simulate({ capacity: () => 60e3, seconds: 300, ...b });
    assert.ok(run.paused >= 0.8 * 300, `${tag} paused ${run.paused}`);
    const tries = run.changes.filter((c) => c.from === 0 && c.t > 100).length;
    assert.ok(tries <= 4, `${tag} tries ${tries}`);
  });
});

test('sim: video comes back, step by step, once the network does', () => {
  each((b, tag) => {
    const run = simulate({
      capacity: (t) => (t < 100 ? 60e3 : 5e6), seconds: 240, ...b,
    });
    assert.equal(rungAt(run, 99), 0, tag);
    assert.equal(rungAt(run, 230), 5, tag);
    const ups = run.changes.filter((c) => c.t > 100 && c.to > c.from);
    assert.ok(ups.every((c) => c.to - c.from === 1 || c.from === 0), `${tag} one rung at a time`);
  });
});

test('sim: connections that share an uplink take turns, and use what it can carry', () => {
  const base = {
    capacity: () => 1e6, links: 5, seconds: 240, estimate: 'limited', limitSignal: true,
  };
  const together = simulate({ ...base, group: false });
  const turns = simulate({ ...base, group: true });
  const sent = (run) => run.sent.at(-1);
  assert.ok(sent(turns) <= 1e6, `fits: ${sent(turns)}`);
  assert.ok(sent(turns) > sent(together), 'uses more of the uplink than all-at-once');
  assert.ok(flaps(turns) < flaps(together), `${flaps(turns)} vs ${flaps(together)} flaps`);
  assert.ok(turns.overload <= 2, `overload ${turns.overload}`);
});

test('sim: an uplink that shrinks is shared out without a long queue', () => {
  const run = simulate({
    capacity: (t) => (t < 80 ? 5e6 : 1e6), links: 3, seconds: 240, estimate: 'limited',
    limitSignal: true,
  });
  assert.ok(run.sent.at(-1) <= 1e6, `fits: ${run.sent.at(-1)}`);
  assert.ok(run.sent.at(-1) >= 0.7e6, `uses it: ${run.sent.at(-1)}`);
  assert.ok(run.overload <= 3, `overload ${run.overload}`);
  assert.ok(Math.max(...run.rungs.at(-1)) <= 3);
});

test('sim: a screen share on a modest link favours sharpness over frame rate', () => {
  const run = simulate({ kind: 'screen', capacity: () => 700e3, ...BROWSERS[2] });
  assert.equal(rungAt(run, 100), 2); // 720p at 8 fps fits, the 1080p rungs do not
  assert.equal(run.paused, 0);
});
