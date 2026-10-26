import test from 'node:test';
import assert from 'node:assert/strict';
import { PreviewCache } from '../src/files/preview-cache.js';
import { MemoryKV } from '../src/store/kv.js';

const blob = (n, fill = 1) => new Blob([new Uint8Array(n).fill(fill)]);
const size = async (cache, id) => (await cache.blob(id))?.size ?? null;

test('stores, returns and survives a restart', async () => {
  const kv = new MemoryKV();
  await new PreviewCache(kv, 'r1').put('a', blob(100));
  const again = new PreviewCache(kv, 'r1');
  assert.equal(await size(again, 'a'), 100);
  assert.equal(await size(again, 'missing'), null);
  assert.equal(await size(new PreviewCache(kv, 'other-room'), 'a'), null);
});

test('evicts the least recently used entries to stay within budget', async () => {
  const kv = new MemoryKV();
  const cache = new PreviewCache(kv, 'r', 250);
  for (const id of ['a', 'b', 'c']) {
    await cache.put(id, blob(100));
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(await size(cache, 'a'), null);
  assert.equal(await size(cache, 'b'), 100);
  assert.equal(await size(cache, 'c'), 100);
  assert.equal(await kv.get('pv:r:a'), undefined); // data is gone, not just the index
  await cache.put('b', blob(200)); // replacing counts the new size, so c has to go
  assert.equal(await size(cache, 'b'), 200);
  assert.equal(await size(cache, 'c'), null);
});

test('clear forgets everything of the room, and only that room', async () => {
  const kv = new MemoryKV();
  const [one, two] = [new PreviewCache(kv, 'one'), new PreviewCache(kv, 'two')];
  await one.put('a', blob(10));
  await two.put('a', blob(10));
  await one.clear();
  assert.equal(await size(one, 'a'), null);
  assert.equal(await size(new PreviewCache(kv, 'one'), 'a'), null);
  assert.equal(await size(two, 'a'), 10);
});

test('concurrent puts keep the index consistent', async () => {
  const cache = new PreviewCache(new MemoryKV(), 'r');
  await Promise.all(['a', 'b', 'c', 'd'].map((id) => cache.put(id, blob(10))));
  for (const id of ['a', 'b', 'c', 'd']) assert.equal(await size(cache, id), 10);
});
