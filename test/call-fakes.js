// Stand-ins for the browser's media pieces, so call logic runs in Node: two FakeRtc objects
// "connect" once each has seen both descriptions, like a real pair of peer connections.
import { randomBytes, toB64u } from '../src/util/bytes.js';

export class FakeTrack {
  enabled = true;
  stopped = false;
  #handlers = {};
  constructor(kind) { this.kind = kind; }
  stop() { this.stopped = true; }
  addEventListener(type, fn) { (this.#handlers[type] ??= []).push(fn); }
  /** The device went away (unplugged, revoked). */
  end() { (this.#handlers.ended ?? []).forEach((fn) => fn()); }
}

export class FakeStream {
  constructor(tracks = []) { this.tracks = [...tracks]; }
  addTrack(track) { this.tracks.push(track); }
  getTracks() { return this.tracks; }
}

/** `denied`: kinds whose device is refused ('screen' too). `tracks`: everything handed out, in
 *  order. `share: false`: a browser without getDisplayMedia (a phone). */
export const fakeMedia = ({ denied = [], share = true } = {}) => ({
  tracks: [],
  available: () => true,
  canShare: () => share,
  async getTrack(kind) {
    if (denied.includes(kind)) throw new Error('permission denied');
    const track = new FakeTrack(kind);
    this.tracks.push(track);
    return track;
  },
  async getScreen() {
    if (denied.includes('screen')) throw new Error('cancelled');
    const track = new FakeTrack('video');
    track.screen = true;
    this.tracks.push(track);
    return track;
  },
});

const transceiver = (kind, direction) => ({
  direction,
  receiver: { track: new FakeTrack(kind) },
  sender: {
    track: null,
    params: { encodings: [{}] },
    async replaceTrack(track) { this.track = track; },
    getParameters() { return structuredClone(this.params); },
    async setParameters(params) { this.params = params; },
  },
});

const sdpOf = (token) => (
  `v=0\r\na=ice-ufrag:${token}\r\nm=audio 9 RTP/AVP 111\r\nm=video 9 RTP/AVP 96\r\n`
);

export class FakeRtc {
  static byToken = new Map();
  iceGatheringState = 'complete';
  connectionState = 'new';
  localDescription = null;
  offerer = false;
  #transceivers = [];
  #remote = null;

  constructor() {
    this.token = toB64u(randomBytes(6));
    FakeRtc.byToken.set(this.token, this);
  }

  addEventListener() {}
  removeEventListener() {}
  getTransceivers() { return this.#transceivers; }
  addTransceiver(kind, { direction }) { this.#transceivers.push(transceiver(kind, direction)); }

  async createOffer() { this.offerer = true; return { type: 'offer', sdp: sdpOf(this.token) }; }
  async createAnswer() { return { type: 'answer', sdp: sdpOf(this.token) }; }
  async setLocalDescription(description) {
    this.localDescription = description;
    this.#connectWhenReady();
  }
  async setRemoteDescription({ type, sdp }) {
    this.#remote = FakeRtc.byToken.get(/a=ice-ufrag:(\S+)/.exec(sdp)[1]);
    if (type === 'offer') {
      for (const kind of ['audio', 'video']) this.#transceivers.push(transceiver(kind, 'recvonly'));
    }
    this.#connectWhenReady();
  }

  #connectWhenReady() {
    if (!this.localDescription || !this.#remote || this.connectionState !== 'new') return;
    this.connectionState = 'connected';
    queueMicrotask(() => {
      for (const { receiver } of this.#transceivers) this.ontrack?.({ track: receiver.track });
      this.onconnectionstatechange?.();
    });
  }

  /** The connection breaks. */
  fail() { this.connectionState = 'failed'; this.onconnectionstatechange?.(); }
  close() { this.connectionState = 'closed'; this.onconnectionstatechange?.(); }
}

/** One call participant's pieces: spread `env` into the Room's `callEnv`. */
export function callParty({ denied, share } = {}) {
  const made = [];
  const media = fakeMedia({ denied, share });
  class Rtc extends FakeRtc { constructor(...a) { super(...a); made.push(this); } }
  return { made, media, env: { RTC: Rtc, Stream: FakeStream, media } };
}

/** The track we currently send on `rtc` for `kind`. */
export const sending = (rtc, kind) => rtc.getTransceivers().find(
  (t) => t.receiver.track.kind === kind,
).sender.track;

/** An AudioContext whose analysers hear loud sound for the streams in `FakeAudio.loud`. */
export class FakeAudio {
  static loud = new Set(); // streams that are "being spoken into"
  static last = null;
  sources = 0;
  closed = false;
  constructor() { FakeAudio.last = this; }
  createAnalyser() {
    return {
      fftSize: 0, stream: null,
      getByteTimeDomainData(bytes) { bytes.fill(FakeAudio.loud.has(this.stream) ? 190 : 128); },
    };
  }
  createMediaStreamSource(stream) {
    this.sources++;
    return { connect(node) { node.stream = stream; }, disconnect() {} };
  }
  async resume() {}
  async close() { this.closed = true; }
}
