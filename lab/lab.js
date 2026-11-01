// P0 connectivity lab. Everything here uses the same modules as the app, so a
// pass means the real code path works on this network.
import { DEFAULTS } from '../src/config.js';
import { hasNative } from '../src/crypto/curves.js';
import { loadIdentity } from '../src/crypto/identity.js';
import { decodeCode, encodeCode, signHandshake, verifyHandshake } from '../src/net/handshake.js';
import { probeNat, probeStun } from '../src/net/ice-probe.js';
import { MqttClient } from '../src/net/mqtt.js';
import { PeerLink } from '../src/net/peer-link.js';
import { MemoryKV } from '../src/store/kv.js';
import { randomBytes } from '../src/util/bytes.js';
import { h } from '../src/ui/dom.js';

const rows = document.getElementById('rows');
const reportBox = document.getElementById('report');
let results = [];

function add(group, check, status, detail = '') {
  results.push({ group, check, status, detail });
  rows.append(
    h(
      'tr',
      {},
      h('td', {}, group),
      h('td', {}, check),
      h('td', { class: status }, status),
      h('td', {}, detail),
    ),
  );
  reportBox.value = JSON.stringify(
    { when: new Date().toISOString(), userAgent: navigator.userAgent, results },
    null,
    2,
  );
}

const withTimeout = (promise, ms, label) =>
  Promise.race(
    [
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
    ],
  );
const once = (emitter, event) => new Promise(
  (resolve) => { const off = emitter.on(event, (...a) => { off(); resolve(a); }); },
);

async function checkEnvironment() {
  add(
    'Browser',
    'secure context',
    isSecureContext ? 'ok' : 'fail',
    isSecureContext ? '' : 'serve over https or localhost',
  );
  add('Browser', 'RTCPeerConnection', globalThis.RTCPeerConnection ? 'ok' : 'fail');
  add('Browser', 'IndexedDB', globalThis.indexedDB ? 'ok' : 'fail');
  add(
    'Browser',
    'BarcodeDetector (camera QR scan)',
    globalThis.BarcodeDetector ? 'ok' : 'info',
    globalThis.BarcodeDetector ? '' : 'paste codes instead',
  );
  try { // the app's own probe: WebCrypto where the browser has it, else the JS fallback
    const native = await hasNative('Ed25519');
    add('Browser', 'Ed25519', native ? 'ok' : 'info',
      native ? 'WebCrypto' : 'JS fallback (slower)');
  }
  catch (err) { add('Browser', 'Ed25519', 'fail', `fallback not loaded: ${err.message}`); }
}

async function checkStun() {
  const probes = await Promise.all(DEFAULTS.stunServers.map((url) => probeStun(url)));
  for (const p of probes) add(
    'STUN',
    p.url,
    p.ok ? 'ok' : 'fail',
    p.ok ? `${p.ms} ms, public address ${p.mapped}` : p.error,
  );
  const good = probes.filter((p) => p.ok).sort((a, b) => a.ms - b.ms);
  if (good.length >= 2) {
    const nat = await probeNat(good[0].url, good[1].url);
    add('NAT', 'mapping behaviour', nat.type === 'unknown' ? 'info' : 'ok',
      nat.type === 'symmetric' ? 'symmetric: direct links often fail, configure a TURN server'
        : nat.type === 'cone' ? 'cone: direct links likely' : 'unknown');
  } else {
    add('NAT', 'mapping behaviour', 'info', 'needs two working STUN servers');
  }
  return good.map((p) => p.url);
}

async function checkBrokers() {
  await Promise.all(DEFAULTS.brokers.map(async (url) => {
    const t0 = performance.now();
    const client = new MqttClient(url, { connectTimeoutMs: 6000 });
    try {
      await client.connect();
      add('Broker', url, 'ok', `${Math.round(performance.now() - t0)} ms`);
    }
    catch (err) { add('Broker', url, 'fail', err.message); }
    finally { client.close(); }
  }));
}

/** Pair two PeerLinks in this page through the real code path (sign -> code -> parse -> verify).
 * */
async function checkLoopback(stun) {
  const iceServers = stun.length ? [{ urls: stun.slice(0, 2) }] : [];
  const [ida, idb] = [await loadIdentity(new MemoryKV()), await loadIdentity(new MemoryKV())];
  const [a, b] = [new PeerLink({ iceServers }), new PeerLink({ iceServers })];
  try {
    const offer = await signHandshake(
      ida,
      {
        kind: 'offer',
        session: randomBytes(8),
        ts: Date.now(),
        name: 'a',
        roomSecret: null,
        sdp: await a.createOffer(),
      },
    );
    const offerCode = encodeCode(offer);
    const offerIn = decodeCode(offerCode);
    await verifyHandshake(offerIn);
    const answer = await signHandshake(
      idb,
      {
        kind: 'answer',
        session: offerIn.session,
        ts: Date.now(),
        name: 'b',
        roomSecret: null,
        sdp: await b.acceptOffer(offerIn.sdp),
      },
    );
    const answerIn = decodeCode(encodeCode(answer));
    await verifyHandshake(answerIn);
    const kinds = offerIn.sdp.candidates.reduce(
      (m, c) => ({ ...m, [c.type]: (m[c.type] ?? 0) + 1 }),
      {},
    );
    const opened = Promise.all([once(a, 'open'), once(b, 'open')]);
    await a.acceptAnswer(answerIn.sdp);
    await withTimeout(opened, 10000, 'data channel');
    b.on('chat', (m) => b.sendChat(m));
    const echo = once(a, 'chat');
    a.sendChat('ping');
    const [reply] = await withTimeout(echo, 3000, 'echo');
    add('Pairing', 'two local peers over WebRTC', reply === 'ping' ? 'ok' : 'fail',
      `pairing code ${offerCode.length} chars; candidates ${JSON.stringify(kinds)}`);
  } catch (err) {
    add('Pairing', 'two local peers over WebRTC', 'fail', err.message);
  } finally { a.close(); b.close(); }
}

async function run() {
  rows.replaceChildren();
  results = [];
  await checkEnvironment();
  const stun = await checkStun();
  await Promise.all([checkBrokers(), checkLoopback(stun)]);
  add('Done', 'lab finished', 'info');
  window.labDone = true;
}

document.getElementById('run').addEventListener('click', run);
document.getElementById('copy').addEventListener(
  'click',
  () => navigator.clipboard?.writeText(reportBox.value),
);
run();
