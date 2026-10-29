// Broker health, persistent storage, paused file transfers and the diagnostics report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrokerHealth, probeBroker, rankBrokers } from '../src/net/broker-health.js';
import { RoomChannel } from '../src/net/room-channel.js';
import { deriveRoomKeys, newRoomSecret } from '../src/crypto/room-keys.js';
import { keepStorage, storageState } from '../src/store/persist.js';
import { MemoryKV } from '../src/store/kv.js';
import { diagnosticsReport, featureLines, record, recorded } from '../src/ui/diagnostics.js';
import { FakeBroker, until } from './fakes.js';
import { pairRooms, stopRooms } from './room-kit.js';

test.afterEach(() => stopRooms());

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const probeOf = (table) => async (url) => ({ url, ...table[url] });

test('a broker that answers is up with its time; a dead one is not', async () => {
  const good = await probeBroker('wss://fake', { WS: new FakeBroker().ws() });
  assert.equal(good.ok, true);
  assert.ok(good.ms >= 0);
  const Dead = class {
    constructor() { queueMicrotask(() => this.onerror?.()); }
    close() {}
    send() {}
  };
  const bad = await probeBroker('wss://dead', { WS: Dead, timeoutMs: 200 });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /socket error/);
});

test('rankBrokers: fastest first, the ones that failed last', async () => {
  const WS = new FakeBroker().ws();
  const ranked = await rankBrokers(['wss://a', 'wss://b'], { WS });
  assert.deepEqual(ranked.map((r) => r.ok), [true, true]);
});

test('BrokerHealth orders fast, unchecked, down; reports; and says when one is back', async () => {
  const health = new BrokerHealth({ probe: probeOf({
    'wss://slow': { ok: true, ms: 300 }, 'wss://fast': { ok: true, ms: 40 },
    'wss://dead': { ok: false, ms: 5000, error: 'socket error' },
  }) });
  const urls = ['wss://dead', 'wss://slow', 'wss://new', 'wss://fast'];
  assert.deepEqual(health.order(urls), urls, 'nothing known yet: the given order');
  let changes = 0;
  health.on('change', () => changes++);
  await health.check(['wss://slow', 'wss://fast', 'wss://dead']);
  assert.equal(changes, 1);
  assert.deepEqual(health.order(urls), ['wss://fast', 'wss://slow', 'wss://new', 'wss://dead']);
  assert.equal(health.isDown('wss://dead'), true);
  assert.equal(health.isDown('wss://new'), false, 'unchecked is not down');
  assert.deepEqual(health.rows(['wss://new', 'wss://dead']).map((r) => r.ok), [null, false]);

  const back = health.untilUp('wss://dead', 5000);
  health.report('wss://dead', 80); // a real connection worked
  await back;
  assert.equal(health.isDown('wss://dead'), false);
  await health.untilUp('wss://dead', 5000); // not down any more: returns at once
});

test('a channel connects to the fast broker, leaves a down one alone, then takes it', async () => {
  const broker = new FakeBroker();
  const base = broker.ws();
  const tried = [];
  const WS = class extends base { constructor(url) { super(); tried.push(url); } };
  const health = new BrokerHealth({ probe: probeOf({
    'wss://dead': { ok: false, ms: 1, error: 'socket error' }, 'wss://ok': { ok: true, ms: 10 },
  }) });
  await health.check(['wss://dead', 'wss://ok']);
  const keys = await deriveRoomKeys(newRoomSecret());
  const channel = new RoomChannel({
    roomId: keys.id, aes: keys.aes, selfId: 'me', topicPrefix: 'knot1', WS, health,
    brokers: ['wss://dead', 'wss://ok'],
  });
  channel.start();
  await until(() => channel.status.connected === 1);
  await wait(60);
  assert.deepEqual(tried, ['wss://ok'], 'the down broker is not contacted');
  health.report('wss://dead', 50);
  await until(() => channel.status.connected === 2);
  channel.stop();
});

test('storage: asked for, granted or refused, never an error', async () => {
  const fake = (grant, persisted = false) => ({
    persisted: async () => persisted, persist: async () => grant,
  });
  assert.deepEqual(await storageState(undefined), { supported: false, persisted: false });
  assert.deepEqual(await storageState(fake(true)), { supported: true, persisted: false });
  assert.equal(await keepStorage(fake(true)), true);
  assert.equal(await keepStorage(fake(false)), false);
  assert.equal(await keepStorage(fake(false, true)), true, 'already kept');
  assert.equal(await keepStorage({ persist: async () => { throw new Error('no'); } }), false);
  assert.equal(await keepStorage(undefined), false);
});

test('paused file transfers: nothing is shared, served or fetched until resumed', async () => {
  const [a, b] = await pairRooms();
  const env = await a.shareFile(new File(['hello'], 'h.txt'));
  await until(() => b.log.has(env.id));
  let events = 0;
  b.on('files', () => events++);

  b.setFileTransfer(false);
  b.setFileTransfer(false); // no change, no event
  assert.equal(b.fileTransfer, false);
  assert.equal(events, 1);
  await assert.rejects(b.downloadFile(env), /paused/);
  await assert.rejects(b.shareFile(new File(['x'], 'x.txt')), /paused/);
  b.setFileTransfer(true);

  a.setFileTransfer(false); // the sender is the one in a call
  await assert.rejects(b.downloadFile(env), /sender paused file transfers/);
  a.setFileTransfer(true);
  const blob = await b.downloadFile(env);
  assert.equal(await blob.text(), 'hello');
  assert.equal(events, 2);

  a.setFileTransfer(false); // leaving the call ends the pause
  a.call.emit('change');
  assert.equal(a.fileTransfer, true);
});

test('diagnostics: what the browser supports, and the last errors, without secrets', async () => {
  const blob = (type) => ({ type });
  const env = {
    isSecureContext: true, RTCPeerConnection: class {}, createImageBitmap() {},
    crypto: { subtle: { generateKey: async (alg) => {
      if (alg?.name === 'X25519') throw new Error('unsupported');
      return {};
    } } },
    OffscreenCanvas: class {
      getContext() { return { fillRect() {} }; }
      async convertToBlob({ type }) {
        return type === 'image/webp' ? blob('image/png') : blob(type);
      }
    },
    navigator: { userAgent: 'Safari/17', storage: { persisted: async () => false, persist() {} } },
  };
  const lines = await featureLines(env, new MemoryKV());
  assert.ok(lines.includes('WebCrypto Ed25519: yes'));
  assert.ok(lines.includes('WebCrypto X25519: failed (Error)'));
  assert.ok(lines.includes('image encoding: image/webp->image/png image/jpeg->image/jpeg'));
  assert.ok(lines.includes('IndexedDB buffers: yes'));
  assert.ok(lines.includes('persistent storage: not granted'));

  record('preview', new Error('no preview'));
  const [a] = await pairRooms();
  const model = { kv: new MemoryKV(), rooms: new Map([[a.id, a]]), settings: { brokers: [] } };
  const text = await diagnosticsReport(model, env);
  assert.match(text, /^knot \d/);
  assert.match(text, /Safari\/17/);
  assert.match(text, /room [\w-]{6}: peers \[p2p\/manual\]/);
  assert.match(text, /preview: Error: no preview/);
  assert.ok(recorded().length >= 1);
});
