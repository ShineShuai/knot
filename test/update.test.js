import test from 'node:test';
import assert from 'node:assert/strict';
import { UpdateWatcher } from '../src/update.js';

function watcher(builds) {
  let clock = 0;
  const reads = [];
  const w = new UpdateWatcher({
    now: () => clock,
    fetchJson: async () => {
      const next = builds.shift();
      reads.push(next);
      if (next instanceof Error) throw next;
      return next;
    },
  });
  let updates = 0;
  w.on('update', () => updates++);
  return { w, reads, updates: () => updates, tick: (ms) => { clock += ms; } };
}

test('tells once when a different build has been published', async () => {
  const x = watcher([{ build: 'a1' }, { build: 'a1' }, { build: 'b2' }, { build: 'c3' }]);
  await x.w.start();
  x.tick(120_000);
  await x.w.check();
  assert.equal(x.updates(), 0, 'same build');
  x.tick(120_000);
  await x.w.check();
  assert.equal(x.updates(), 1);
  x.tick(120_000);
  await x.w.check();
  assert.equal(x.updates(), 1, 'one notice is enough');
  assert.equal(x.reads.length, 3, 'and it stops asking');
});

test('checks at most once a minute', async () => {
  const x = watcher([{ build: 'a1' }, { build: 'a1' }, { build: 'a1' }]);
  await x.w.start();
  x.tick(70_000);
  await x.w.check();
  x.tick(10_000);
  await x.w.check();
  x.tick(10_000);
  await x.w.check();
  assert.equal(x.reads.length, 2);
});

test('no build.json (local development), errors and junk never raise a notice', async () => {
  const none = watcher([new Error('HTTP 404')]);
  await none.w.start();
  none.tick(120_000);
  await none.w.check();
  assert.equal(none.updates(), 0);
  assert.equal(none.reads.length, 1, 'nothing to compare, so it does not keep asking');

  const flaky = watcher([{ build: 'a1' }, new Error('offline'), {}, { build: 7 }, { build: 'a1' }]);
  await flaky.w.start();
  for (let i = 0; i < 4; i++) { flaky.tick(120_000); await flaky.w.check(); }
  assert.equal(flaky.updates(), 0);
});
