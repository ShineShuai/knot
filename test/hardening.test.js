// Names and file names that pretend, quotes that lie, files for strangers, connections that die
// quietly, a database connection the browser closed, stamps from the future, and more candidates
// than fit in a code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../src/config.js';
import { DeviceSync } from '../src/chat/device-sync.js';
import { CallLink } from '../src/call/call-link.js';
import { decodeCode, encodeCode, signHandshake } from '../src/net/handshake.js';
import { parseSdp } from '../src/net/sdp.js';
import { MemoryKV, IdbKV } from '../src/store/kv.js';
import { safeFileName } from '../src/ui/dom.js';
import { plain } from '../src/util/text.js';
import { randomBytes } from '../src/util/bytes.js';
import { newIdentity, sampleSdp } from './helpers.js';
import { until } from './fakes.js';
import { link, makeRoom, stopRooms } from './room-kit.js';

test.afterEach(stopRooms);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('plain: direction overrides, invisible marks and controls go; letters and emoji stay', () => {
  assert.equal(plain('Ada\u202e'), 'Ada');
  assert.equal(plain('inv\u200boice'), 'invoice');
  assert.equal(plain(' a\u0000b\nc '), 'abc');
  assert.equal(plain('👩‍💻 Zoë 李'), '👩‍💻 Zoë 李'); // the joiner (U+200D) is part of an emoji
  assert.equal(plain(null), '');
});

test('safeFileName: a file cannot hide its extension behind a right-to-left override', () => {
  const name = safeFileName('photo\u202egpj.exe');
  assert.equal(name, 'photogpj.exe');
  assert.equal(safeFileName('a/b\\c:d'), 'a_b_c_d');
  assert.equal(safeFileName('\u202e'), 'file');
});

test('device sync: a stamp from the far future is refused (it would win for ever)', async () => {
  const settings = { ...DEFAULTS };
  const sync = new DeviceSync({ kv: new MemoryKV(), settings, deviceId: 'dev1' });
  await sync.load();
  const item = (ms) => ({ name: { v: 'Eve', ms, c: 0, by: 'dev2' } });
  assert.deepEqual(await sync.merge(item(Date.now() + 3_600_000)), {});
  assert.equal(settings.name, DEFAULTS.name);
  assert.deepEqual(Object.keys(await sync.merge(item(Date.now()))), ['name']);
});

test('a link that stays disconnected is closed, a call connection too', async () => {
  let pc;
  class RTC {
    connectionState = 'connected';
    constructor() { pc = this; }
    createDataChannel() { return { close() {} }; }
    getTransceivers() { return []; }
    close() {}
  }
  class Stream { addTrack() {} }
  const call = new CallLink({ RTC, Stream, disconnectGraceMs: 100 });
  let closed = 0;
  call.on('close', () => closed++);
  pc.connectionState = 'disconnected'; pc.onconnectionstatechange();
  pc.connectionState = 'connected'; pc.onconnectionstatechange(); // healed in time
  await wait(250);
  assert.equal(closed, 0);
  pc.connectionState = 'disconnected'; pc.onconnectionstatechange();
  await until(() => closed === 1);
});

test('a code keeps the candidates that reach beyond the LAN, whatever the hosts', async () => {
  const lines = [];
  for (let i = 0; i < 10; i++) {
    lines.push(`a=candidate:${i} 1 udp 2122260223 192.0.2.${10 + i} 5${i}000 typ host`);
  }
  lines.push('a=candidate:20 1 udp 1686052607 203.0.113.7 61000 typ srflx raddr 0.0.0.0 rport 0');
  const sdp = sampleSdp().replace(/a=candidate:.*\r?\n/g, '').replace(
    /(a=ice-pwd:.*\r?\n)/, `$1${lines.join('\r\n')}\r\n`,
  );
  const h = await signHandshake(await newIdentity(), {
    kind: 'offer', session: randomBytes(8), ts: Date.now(), name: 'Ada',
    roomSecret: randomBytes(16), sdp: parseSdp(sdp),
  });
  const types = decodeCode(encodeCode(h)).sdp.candidates.map((c) => c.type);
  assert.equal(types.length, 8);
  assert.ok(types.includes('srflx'), 'the server-reflexive candidate survives');
});

test('a link of someone who is not (yet) a member gets no files', async () => {
  const [boss, guest] = [await newIdentity(), await newIdentity()];
  const owner = await makeRoom({ name: 'Boss', identity: boss, owner: boss.id });
  const secret = owner.secret;
  const offer = decodeCode((await owner.createInvite()).code);
  const g = await makeRoom({ secret, name: 'Gil', identity: guest, owner: boss.id });
  await owner.acceptAnswer(decodeCode((await g.answerOffer(offer)).code));
  const { link: toOwner } = [...g.peers.values()][0];
  const seen = [];
  owner.files.onFrame = (_link, data) => seen.push(data);
  const entry = [...owner.peers.values()][0];
  entry.synced = false;
  await toOwner.sendFile('{"t":"get"}');
  await wait(100);
  assert.equal(seen.length, 0, 'not a member: ignored');
  entry.synced = true;
  await toOwner.sendFile('{"t":"get"}');
  await until(() => seen.length === 1);
});

/** Just enough of IndexedDB for IdbKV: one store, the first transaction fails as in WebKit. */
function fakeIndexedDb({ failFirstTransaction = false } = {}) {
  const data = new Map();
  let opens = 0, failed = false;
  const db = () => {
    const self = {
      onclose: null, onversionchange: null, close() {},
      transaction() {
        if (failFirstTransaction && !failed) {
          failed = true;
          const closing = new Error('The database connection is closing.');
          throw Object.assign(closing, { name: 'InvalidStateError' });
        }
        const tx = {};
        tx.objectStore = () => ({
          get: (key) => {
            setTimeout(() => tx.oncomplete(), 0);
            return { result: data.get(key) };
          },
          put: (value, key) => {
            data.set(key, value);
            setTimeout(() => tx.oncomplete(), 0);
            return {};
          },
        });
        return tx;
      },
    };
    return self;
  };
  const indexedDB = {
    open() {
      opens++;
      const req = {};
      setTimeout(() => { req.result = db(); req.onsuccess(); }, 0);
      return req;
    },
  };
  return { indexedDB, opens: () => opens };
}

test('IdbKV opens a new connection when the browser closed the old one', async () => {
  const fake = fakeIndexedDb({ failFirstTransaction: true });
  globalThis.indexedDB = fake.indexedDB;
  try {
    const kv = new IdbKV('t');
    await kv.put('a', 1);
    assert.equal(await kv.get('a'), 1);
    assert.equal(fake.opens(), 2, 'one retry on a fresh connection, no more');
  } finally { delete globalThis.indexedDB; }
});
