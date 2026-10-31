// A plain-text report for when something works in one browser and not in another (Safari!):
// what the browser supports, how each room's links look, the brokers, and the last errors
// the page hit. Copied from Settings > Diagnostics; contains no message text or keys.
import { VERSION } from '../version.js';
import { storageState } from '../store/persist.js';

const MAX_ENTRIES = 30;
const entries = [];

/** Remember an error (kept in memory only) for the report. */
export function record(where, err) {
  const text = String(err?.stack?.split('\n')[0] || err?.message || err).slice(0, 200);
  entries.push(`${new Date().toISOString().slice(11, 19)} ${where}: ${text}`);
  if (entries.length > MAX_ENTRIES) entries.shift();
}
export const recorded = () => [...entries];

/** Record uncaught errors and rejected promises of the page. */
export function watchErrors(target = globalThis) {
  target.addEventListener?.('error', (e) => record('error', e.error ?? e.message));
  target.addEventListener?.('unhandledrejection', (e) => record('rejection', e.reason));
}

const yes = (ok) => (ok ? 'yes' : 'NO');
const attempt = async (fn) => {
  try { return await fn(); } catch (err) { return `failed (${err.name})`; }
};

/** What this browser can do, as lines. `env` is the global scope (a fake in tests). */
export async function featureLines(env = globalThis, kv = null) {
  const subtle = env.crypto?.subtle;
  const key = (alg, usages) => attempt(async () => {
    await subtle.generateKey(alg, false, usages);
    return 'yes';
  });
  const canvas = async () => {
    if (typeof env.OffscreenCanvas === 'undefined') return 'no OffscreenCanvas';
    const c = new env.OffscreenCanvas(8, 8);
    c.getContext('2d').fillRect(0, 0, 8, 8);
    const types = [];
    for (const type of ['image/webp', 'image/jpeg']) {
      const blob = await c.convertToBlob({ type }).catch(() => null);
      types.push(`${type}->${blob?.type || 'fails'}`);
    }
    return types.join(' ');
  };
  const store = async () => {
    await kv.put('diag', new Uint8Array([1, 2, 3]).buffer);
    const back = await kv.get('diag');
    await kv.delete('diag');
    return back?.byteLength === 3 ? 'yes' : 'wrong data back';
  };
  const ed = subtle ? await key('Ed25519', ['sign', 'verify']) : 'NO';
  const x = subtle ? await key({ name: 'X25519' }, ['deriveBits']) : 'NO';
  const rows = [
    ['secure context', yes(env.isSecureContext)],
    ['WebRTC', yes(env.RTCPeerConnection)],
    ['WebCrypto Ed25519', ed],
    ['WebCrypto X25519', x],
    // LEGACY-CURVES
    ['Curve25519 used', ed === 'yes' && x === 'yes' ? 'WebCrypto' : 'JS fallback (slower)'],
    ['createImageBitmap', yes(typeof env.createImageBitmap === 'function')],
    ['image encoding', await attempt(canvas)],
    ['IndexedDB buffers', kv ? await attempt(store) : 'n/a'],
    ['IntersectionObserver', yes(env.IntersectionObserver)],
    ['camera and microphone', yes(env.navigator?.mediaDevices?.getUserMedia)],
    ['screen sharing', yes(env.navigator?.mediaDevices?.getDisplayMedia)],
    ['notifications', yes(env.Notification)],
    ['service worker', yes(env.navigator?.serviceWorker)],
  ];
  const kept = await storageState(env.navigator?.storage);
  rows.push(['persistent storage', kept.supported ? (kept.persisted ? 'granted' : 'not granted')
    : 'unsupported']);
  return rows.map(([name, value]) => `${name}: ${value}`);
}

/** The whole report. */
export async function diagnosticsReport(model, env = globalThis) {
  const lines = [`knot ${VERSION}`, env.navigator?.userAgent ?? 'unknown browser', '',
    ...(await featureLines(env, model.kv)), ''];
  for (const room of model.rooms.values()) {
    const peers = room.peerList.map((p) => `${p.state}${p.via ? `/${p.via}` : ''}`);
    const b = room.brokerStatus ?? {};
    lines.push(`room ${room.id.slice(0, 6)}: peers [${peers.join(', ')}]`
      + ` brokers ${b.connected ?? '?'}/${b.total ?? '?'}`);
  }
  const rows = model.brokerHealth?.rows(model.settings.brokers) ?? [];
  for (const r of rows) {
    lines.push(`broker ${r.url}: ${r.ok === null ? 'not checked' : r.ok ? `${r.ms} ms`
      : `down (${r.error})`}`);
  }
  lines.push('', 'recent errors:', ...(entries.length ? entries : ['none']));
  return lines.join('\n');
}
