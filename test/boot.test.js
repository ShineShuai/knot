// When the app does not start: the page says what it waits for, why, and what to try; one damaged
// room does not stop the others; storage that never answers fails with a reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { AppModel } from '../src/app.js';
import { DEFAULTS } from '../src/config.js';
import { newRoomSecret } from '../src/crypto/room-keys.js';
import { IdbKV, MemoryKV } from '../src/store/kv.js';
import { toB64u } from '../src/util/bytes.js';
import { newIdentity } from './helpers.js';
import { FakeElement } from './fake-dom.js';

const GUARD = readFileSync(new URL('../src/boot-guard.js', import.meta.url), 'utf8');

/** Run boot-guard.js against a fake page; `timers` are run by hand. */
function page({ online = true } = {}) {
  const app = new FakeElement('div');
  app.textContent = 'Loading…';
  const listeners = {};
  const timers = [];
  const store = new Map();
  const win = {
    addEventListener: (type, fn) => (listeners[type] ??= []).push(fn),
  };
  const reloads = [];
  const ctx = {
    window: win,
    document: {
      getElementById: () => app, createElement: (tag) => new FakeElement(tag),
      querySelector: () => null,
    },
    navigator: {
      userAgent: 'TestBrowser/1', onLine: online,
      serviceWorker: {
        getRegistrations: async () => [
          { unregister: async () => { reloads.push('unregistered'); } },
        ],
      },
    },
    caches: {
      keys: async () => ['knot-v2'], delete: async () => { reloads.push('cache deleted'); },
    },
    location: { reload: () => reloads.push('reload') },
    sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    Date,
  };
  vm.runInNewContext(GUARD, ctx);
  const fire = (type, event) => (listeners[type] ?? []).forEach((fn) => fn(event));
  const runTimers = () => { for (const t of timers.splice(0)) t.fn(); };
  return { app, win, fire, runTimers, reloads, store };
}

test('a page that does not start says what it waits for and what to try', () => {
  const { app, win, runTimers } = page();
  win.knotStage('storage');
  runTimers();
  const text = app.textContent;
  assert.match(text, /knot is not starting/);
  assert.match(text, /Waiting for: storage/);
  assert.match(text, /browser storage did not answer/);
  assert.equal(app.querySelectorAll('button').length, 3);
});

test('a page that started stays quiet', () => {
  const { app, win, runTimers } = page();
  win.knotBooted();
  runTimers();
  assert.equal(app.textContent, 'Loading…');
});

test('a file that fails to load is named; the saved copy is repaired once', async () => {
  const { app, win, fire, runTimers, reloads, store } = page();
  fire('error', { target: { src: 'https://x/src/room.js', tagName: 'SCRIPT' } });
  runTimers(); // the repair and the "still starting" timers
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(reloads.includes('cache deleted') && reloads.includes('reload'));
  assert.equal(store.get('knot-repaired'), '1');
  assert.match(app.textContent, /could not load https:\/\/x\/src\/room\.js/);
  assert.match(app.textContent, /did not load, or its files come from two versions/);
  // it does not loop: a second failure in the same visit only reports
  reloads.length = 0;
  fire('error', { target: { src: 'https://x/src/app.js', tagName: 'SCRIPT' } });
  runTimers();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reloads, []);
  assert.equal(typeof win.knotFail, 'function');
});

test('offline, nothing is cleared (the saved copy is all there is)', async () => {
  const { fire, runTimers, reloads } = page({ online: false });
  fire('error', { target: { src: 'https://x/src/room.js', tagName: 'SCRIPT' } });
  runTimers();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reloads, []);
});

test('one room that cannot be opened does not keep the others from opening', async () => {
  const kv = new MemoryKV();
  const good = newRoomSecret();
  await kv.put('rooms', [
    { secret: '!!not-base64!!', label: 'Broken', owner: null },
    { secret: toB64u(good), label: 'Fine', owner: null },
  ]);
  const settings = { ...DEFAULTS, name: 'Ada', brokersEnabled: false, brokers: [] };
  const model = new AppModel({ kv, identity: await newIdentity(), settings, iceServers: () => [] });
  const progress = [];
  await model.load({ progress: (what) => progress.push(what) });
  assert.deepEqual([...model.rooms.values()].map((r) => r.label), ['Fine']);
  assert.deepEqual(model.loadErrors.map((e) => e.label), ['Broken']);
  assert.ok(progress.some((p) => p.startsWith('1 of 2')));
  assert.ok(progress.some((p) => p.startsWith('2 of 2')));
  model.stop();
});

test('storage that never answers fails with a reason, and the next call tries again', async () => {
  let opens = 0;
  globalThis.indexedDB = {
    open() {
      opens++;
      const req = {};
      if (opens > 1) {
        setTimeout(() => {
          req.result = {
            transaction: () => {
              const tx = {};
              tx.objectStore = () => ({
                get: () => { setTimeout(() => tx.oncomplete(), 0); return { result: 7 }; },
              });
              return tx;
            },
          };
          req.onsuccess();
        }, 0);
      }
      return req;
    },
  };
  try {
    const kv = new IdbKV('t', { openTimeoutMs: 30 });
    await assert.rejects(kv.get('a'), /did not answer within/);
    assert.equal(await kv.get('a'), 7);
    assert.equal(opens, 2);
  } finally { delete globalThis.indexedDB; }
});
