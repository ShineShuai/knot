// One tab per browser profile: the second one is told, and a missing or broken Web Locks API
// never locks anybody out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { holdInstance } from '../src/store/instance-lock.js';

/** The part of navigator.locks we use: one holder per name, kept while the callback's promise
 *  is pending; `ifAvailable` calls back with null if it is held. */
function fakeLocks() {
  const held = new Set();
  return {
    async request(name, opts, callback) {
      if (held.has(name)) return callback(null);
      held.add(name);
      return callback({ name });
    },
  };
}

test('the first tab gets the lock, a second one does not', async () => {
  const locks = fakeLocks();
  assert.equal(await holdInstance(locks), true);
  assert.equal(await holdInstance(locks, undefined, { retries: 0 }), false);
  assert.equal(await holdInstance(locks, 'other-name'), true);
});

test('a tab that reloads gets the lock once the old page has let go', async () => {
  const locks = fakeLocks();
  let calls = 0;
  const flaky = { request: (...args) => (++calls < 3 ? args[2](null) : locks.request(...args)) };
  assert.equal(await holdInstance(flaky, 'knot-instance', { delay: 1 }), true);
  assert.equal(calls, 3);
});

test('without Web Locks, or with a broken one, the tab runs', async () => {
  assert.equal(await holdInstance(undefined), true);
  assert.equal(await holdInstance({}), true);
  assert.equal(await holdInstance({ request: async () => { throw new Error('nope'); } }), true);
});
