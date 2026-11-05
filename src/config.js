// LEGACY-CURVES: when to drop the fallback for browsers without WebCrypto Ed25519 / X25519
// (iOS 16 and older; crypto/curves.js). It costs a vendored library, slower crypto, a weaker
// identity key and a second code path. There is no telemetry: ask the people who use the app
// whether anyone still needs it (Settings > Diagnostics shows "Curve25519 used: JS fallback"
// on such a device). test/legacy-curves.test.js fails after this date: decide, then either
// push the date out or remove it:
//   1. grep -rn LEGACY-CURVES (code, tests, CI, docs) and delete what it marks; delete
//      src/vendor/nacl-fast.js, src/crypto/soft-key.js, test/soft-curves.mjs, the test:soft
//      script, test/legacy-curves.test.js and this constant.
//   2. Device identities sealed on an old browser move into WebCrypto when it first runs on a
//      browser that can. Keep `loadSealed` and soft-key.js's `openSeed` while such a device may
//      still update, or it loses its identity (peer id, owned rooms) when it does.
export const LEGACY_CURVES_REVIEW_BY = '2027-10-31';

// Central defaults. Everything environment-dependent lives here and can be
// overridden by the user in Settings (stored under the "settings" key).
export const DEFAULTS = Object.freeze({
  name: '',
  language: 'auto', // auto: the browser's | en | zh | de
  topicPrefix: 'knot1',
  // STUN servers; the list is ranked by speed at startup. Servers reachable from
  // mainland China come first. Verify the list with lab/lab.html on real networks.
  stunServers: [
    'stun:stun.cdnbye.com:3478',
    'stun:stun.miwifi.com:3478',
    'stun:stun.chat.bilibili.com:3478',
    'stun:stun.cloudflare.com:3478',
    'stun:stun.l.google.com:19302',
  ],
  // [{ urls: 'turns:turn.example.org:443?transport=tcp', username: '', credential: '' }]
  turnServers: [],
  // Public MQTT brokers (WebSocket, TLS). Used only for rendezvous and text relay.
  brokers: [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/',
  ],
  brokersEnabled: true,
  relayFallback: true, // send text through brokers if some member has no P2P link
  notifications: false, // browser notifications for messages in rooms that are not on screen
  gatherTimeoutMs: 3000,
  connectTimeoutMs: 20000,
  inviteTtlMs: 10 * 60 * 1000,
  presenceIntervalMs: 15000,
  maxTextLength: 4000,
  logCap: 1000,
  syncWindow: 300,
  chunkSize: 16 * 1024,
  maxFileBytes: 100 * 1024 * 1024,
  adminTimeoutMs: 15000, // a peer not shown to be a member by then is dropped
  imagePreviews: 'auto', // auto: thumbnail + preview when visible | tap: preview on tap | off
  previewCacheBytes: 64 * 1024 * 1024, // per room, on this device
  messagesPerSecond: 20,
  callMaxParticipants: 6, // a mesh: every extra person adds a stream to send and to receive
  callRetryMs: 1000, // first pause before a dropped call connection is offered again
  callAloneMs: 5 * 60 * 1000, // leave a call this long after the last other person left (0: never)
});

/** The network settings as they are by default, as fresh copies ("Reset to defaults"). */
export const networkDefaults = () => structuredClone({
  brokersEnabled: DEFAULTS.brokersEnabled, relayFallback: DEFAULTS.relayFallback,
  brokers: DEFAULTS.brokers, stunServers: DEFAULTS.stunServers, turnServers: DEFAULTS.turnServers,
});

const MAX_LIST = 10; // as many entries and
const MAX_URL = 200; // as many characters as the shared settings accept (chat/device-sync.js)
const MAX_TURN_JSON = 2000;
const ICE_URL = /^(turns?|stuns?):/;

/** What is wrong with the network lists, as [{ field, code, n }]: the field ('stun', 'brokers',
 *  'turn'), the text to show (an i18n key) and the entry's number from 1. [] if all is well. */
export function networkProblems({ stunServers, brokers, turnServers }) {
  const found = [];
  const list = (field, urls, ok, code) => {
    const bad = urls.findIndex((u) => !ok(u));
    if (bad >= 0) found.push({ field, code, n: bad + 1 });
    else if (urls.length > MAX_LIST || urls.some((u) => u.length > MAX_URL)) {
      found.push({ field, code: 'listLimits', n: MAX_LIST });
    }
  };
  list('stun', stunServers, (u) => /^stuns?:/.test(u), 'badStun');
  list('brokers', brokers, (u) => u.startsWith('wss://'), 'badBroker');
  turnServers.forEach((server, i) => {
    const urls = [server.urls].flat().filter(Boolean);
    if (!urls.every((u) => ICE_URL.test(u))) {
      found.push({ field: 'turn', code: 'badTurn', n: i + 1 });
    } else if (urls.some((u) => u.startsWith('turn')) && !(server.username && server.credential)) {
      found.push({ field: 'turn', code: 'turnLogin', n: i + 1 }); // browsers refuse it without
    }
  });
  if (turnServers.length > MAX_LIST || JSON.stringify(turnServers).length > MAX_TURN_JSON) {
    found.push({ field: 'turn', code: 'listLimits', n: MAX_LIST });
  }
  return found;
}

export async function loadSettings(kv) {
  return { ...DEFAULTS, ...((await kv.get('settings')) ?? {}) };
}

export const saveSettings = (kv, settings) => kv.put('settings', settings);

/** ICE server list for RTCPeerConnection from settings (+ optional ranked STUN). */
export function iceServersFrom(settings, rankedStun = null) {
  const stun = (rankedStun ?? settings.stunServers).slice(0, 3);
  return [...(stun.length ? [{ urls: stun }] : []), ...settings.turnServers];
}
