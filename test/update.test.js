import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { UpdateWatcher } from '../src/update.js';

function watcher(running, builds) {
  let clock = 0;
  const reads = [];
  const w = new UpdateWatcher({
    running,
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
  const x = watcher('a1', [{ build: 'a1' }, { build: 'b2' }, { build: 'c3' }]);
  x.w.start();
  x.tick(120_000);
  await x.w.check();
  assert.equal(x.updates(), 0, 'same build');
  x.tick(120_000);
  await x.w.check();
  assert.equal(x.updates(), 1);
  x.tick(120_000);
  await x.w.check();
  assert.equal(x.updates(), 1, 'one notice is enough');
  assert.equal(x.reads.length, 2, 'and it stops asking');
});

test('checks at most once a minute', async () => {
  const x = watcher('a1', [{ build: 'a1' }, { build: 'a1' }, { build: 'a1' }]);
  x.w.start();
  x.tick(70_000);
  await x.w.check();
  x.tick(10_000);
  await x.w.check();
  x.tick(70_000);
  await x.w.check();
  assert.equal(x.reads.length, 2);
});

test('a page that is not a stamped deploy never asks for build.json', async () => {
  for (const running of [null, undefined, '']) {
    const x = watcher(running, [{ build: 'zzz' }]);
    x.w.start();
    x.tick(120_000);
    await x.w.check();
    assert.equal(x.reads.length, 0, 'a missing file would be a console error');
    assert.equal(x.updates(), 0);
  }
});

test('errors and junk never raise a notice', async () => {
  const flaky = watcher('a1', [new Error('offline'), {}, { build: 7 }, { build: 'a1' }]);
  flaky.w.start();
  for (let i = 0; i < 4; i++) { flaky.tick(120_000); await flaky.w.check(); }
  assert.equal(flaky.updates(), 0);
});

test('index.html has the empty build stamp the deploy fills in', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.equal(html.split('<meta name="build" content="">').length, 2);
});
