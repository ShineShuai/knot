import test from 'node:test';
import assert from 'node:assert/strict';
import { loadIdentity } from '../src/crypto/identity.js';
import { IdbKV, MemoryKV } from '../src/store/kv.js';
import { noteBorn, noteLoss, traceLines } from '../src/store/trace.js';
import { diagnosticsReport } from '../src/ui/diagnostics.js';

const T = Date.UTC(2026, 10, 22, 14, 3);
const HOUR = 3_600_000;

/** Just enough of IndexedDB for IdbKV; `dbs` are the connections, `data` the one store. */
function fakeIndexedDb() {
  const data = new Map();
  const dbs = [];
  const connect = () => {
    const db = {
      onclose: null,
      onversionchange: null,
      close() {},
      transaction() {
        const tx = {};
        const done = () => setTimeout(() => tx.oncomplete(), 0);
        tx.objectStore = () => ({
          get: (key) => { done(); return { result: data.get(key) }; },
          put: (value, key) => { data.set(key, value); done(); return {}; },
        });
        return tx;
      },
    };
    dbs.push(db);
    return db;
  };
  const indexedDB = {
    open() {
      const req = {};
      setTimeout(() => { req.result = connect(); req.onsuccess(); }, 0);
      return req;
    },
  };
  return { data, dbs, indexedDB };
}

test('a new identity notes when it was made; a stored one leaves the note alone', async () => {
  const kv = new MemoryKV();
  const before = Date.now();
  await loadIdentity(kv);
  const born = await kv.get('born');
  assert.ok(born >= before && born <= Date.now());
  await kv.put('born', T);
  await loadIdentity(kv);
  assert.equal(await kv.get('born'), T, 'the identity already existed');
});

test('trace lines: age of the identity, and "unknown" for data of an older version', async () => {
  const kv = new MemoryKV();
  assert.deepEqual(await traceLines(kv, T), ['identity created: unknown (older version)']);
  await noteBorn(kv, T - 5 * 60_000);
  assert.deepEqual(await traceLines(kv, T), ['identity created: 2026-11-22 13:58 UTC (5 min ago)']);
  await noteBorn(kv, T - 30 * HOUR);
  assert.match((await traceLines(kv, T))[0], /2026-11-21 08:03 UTC \(30 h ago\)$/);
  await noteBorn(kv, T - 90 * 24 * HOUR);
  assert.match((await traceLines(kv, T))[0], /\(90 days ago\)$/);
});

test('trace lines: a read error is reported, not thrown', async () => {
  const fail = () => { throw Object.assign(new Error('x'), { name: 'UnknownError' }); };
  const kv = { get: async () => fail() };
  assert.deepEqual(await traceLines(kv, T), ['identity created: unreadable (UnknownError)']);
});

test('noteLoss: only an empty database (identity gone) counts as wiped', async () => {
  const kv = new MemoryKV();
  await kv.put('identity', {});
  await noteLoss(kv, T);
  assert.equal(await kv.get('lost'), undefined, 'the data is still there');
  await kv.delete('identity');
  await noteLoss(kv, T);
  assert.equal(await kv.get('lost'), T);
  assert.match((await traceLines(kv, T + HOUR))[1],
    /^data wiped under a running page: 2026-11-22 14:03 UTC \(60 min ago\)$/);
});

test('IdbKV tells when the browser closes the connection; a wipe is then noted', async () => {
  const fake = fakeIndexedDb();
  globalThis.indexedDB = fake.indexedDB;
  try {
    const kv = new IdbKV('t');
    let noted;
    kv.onClosed = () => { noted = noteLoss(kv, T); };
    await kv.put('identity', { key: 1 });
    fake.dbs[0].onclose(); // closed, but nothing lost (WebKit does this when idle)
    await noted;
    assert.equal(fake.data.has('lost'), false);
    fake.data.clear(); // the site's data wiped while the page runs
    fake.dbs[1].onclose();
    await noted;
    assert.equal(fake.data.get('lost'), T);
    assert.equal(fake.dbs.length, 3, 'each look opened a fresh connection');
  } finally { delete globalThis.indexedDB; }
});

test('the diagnostics report shows the address and the trace lines', async () => {
  const kv = new MemoryKV();
  await noteBorn(kv, Date.now() - 2 * HOUR);
  const env = {
    navigator: { userAgent: 'Chrome/150' },
    location: { origin: 'https://shineshuai.github.io', pathname: '/knot/', hash: '#r=secret' },
  };
  const text = await diagnosticsReport({ kv, rooms: new Map(), settings: { brokers: [] } }, env);
  assert.match(text, /^address: https:\/\/shineshuai\.github\.io\/knot\/$/m);
  assert.match(text, /^identity created: .* UTC \(2 h ago\)$/m);
  assert.doesNotMatch(text, /secret/);
});
