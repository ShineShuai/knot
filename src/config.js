// Central defaults. Everything environment-dependent lives here and can be
// overridden by the user in Settings (stored under the "settings" key).
export const DEFAULTS = Object.freeze({
  name: '',
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
  gatherTimeoutMs: 3000,
  connectTimeoutMs: 20000,
  inviteTtlMs: 10 * 60 * 1000,
  presenceIntervalMs: 15000,
  maxTextLength: 4000,
  logCap: 1000,
  syncWindow: 300,
  chunkSize: 16 * 1024,
  maxFileBytes: 100 * 1024 * 1024,
  imagePreviews: 'auto', // auto: thumbnail + preview when visible | tap: preview on tap | off
  previewCacheBytes: 64 * 1024 * 1024, // per room, on this device
  messagesPerSecond: 20,
});

export async function loadSettings(kv) {
  return { ...DEFAULTS, ...((await kv.get('settings')) ?? {}) };
}

export const saveSettings = (kv, settings) => kv.put('settings', settings);

/** ICE server list for RTCPeerConnection from settings (+ optional ranked STUN). */
export function iceServersFrom(settings, rankedStun = null) {
  const stun = (rankedStun ?? settings.stunServers).slice(0, 3);
  return [...(stun.length ? [{ urls: stun }] : []), ...settings.turnServers];
}
