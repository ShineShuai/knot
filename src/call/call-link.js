// One WebRTC media connection to one call participant. Signaling is not this class's
// business: the call manager carries complete SDP over the room's authenticated chat link,
// so there is no size limit and no code to show.
//
// The connection always has the same two transceivers (audio, video, both send+receive).
// Muting or switching the camera is then `replaceTrack` on a sender and never renegotiates,
// so only one side ever creates offers (see call.js) and nothing can collide.
// Events: 'connected', 'close'
import { Emitter } from '../util/emitter.js';
import { gathered } from '../net/ice-gather.js';
import { DEGRADATION, readStats } from './quality.js';

const MAX_SDP_CHARS = 24_000;

/** Accept only an SDP with exactly the two media sections we create: audio, then video. */
export function validSdp(sdp) {
  if (typeof sdp !== 'string' || sdp.length > MAX_SDP_CHARS) return false;
  const kinds = [...sdp.matchAll(/^m=(\S+)/gm)].map((m) => m[1]);
  return kinds.length === 2 && kinds[0] === 'audio' && kinds[1] === 'video';
}

export class CallLink extends Emitter {
  state = 'connecting'; // connecting | connected | closed
  /** What the other side sends us; its tracks are added as they arrive. */
  stream;
  #pc; #gatherMs; #tracks = { audio: null, video: null };
  #profile = null; #busy = false; #dirty = false; #noPreference = false;

  constructor({
    iceServers = [], gatherTimeoutMs = 3000, connectTimeoutMs = 20000,
    RTC = globalThis.RTCPeerConnection, Stream = globalThis.MediaStream,
  } = {}) {
    super();
    this.#gatherMs = gatherTimeoutMs;
    this.stream = new Stream();
    this.#pc = new RTC({ iceServers });
    this.#pc.ontrack = ({ track }) => this.stream.addTrack(track);
    this.#pc.onconnectionstatechange = () => {
      const s = this.#pc.connectionState;
      if (s === 'connected' && this.state === 'connecting') {
        this.state = 'connected';
        this.#prioritizeAudio();
        this.#flush();
        this.emit('connected');
      } else if (s === 'failed' || s === 'closed') this.close();
    };
    const timer = setTimeout(() => this.state === 'connecting' && this.close(), connectTimeoutMs);
    timer.unref?.();
    this.on('close', () => clearTimeout(timer));
  }

  // ---- signaling: whole SDP strings ------------------------------------------------

  async createOffer() {
    for (const kind of ['audio', 'video']) {
      this.#pc.addTransceiver(kind, { direction: 'sendrecv' });
    }
    this.#applyTracks();
    await this.#pc.setLocalDescription(await this.#pc.createOffer());
    return this.#localSdp();
  }

  async acceptOffer(sdp) {
    await this.#pc.setRemoteDescription({ type: 'offer', sdp });
    // An answerer's transceivers start receive-only; ours also send.
    for (const t of this.#pc.getTransceivers()) t.direction = 'sendrecv';
    this.#applyTracks();
    await this.#pc.setLocalDescription(await this.#pc.createAnswer());
    return this.#localSdp();
  }

  acceptAnswer(sdp) { return this.#pc.setRemoteDescription({ type: 'answer', sdp }); }

  async #localSdp() {
    await gathered(this.#pc, this.#gatherMs);
    return this.#pc.localDescription.sdp;
  }

  // ---- what we send ---------------------------------------------------------------------

  /** The tracks to send (null: nothing of that kind). Safe to call at any time. */
  setTracks({ audio = null, video = null }) {
    this.#tracks = { audio, video };
    this.#applyTracks();
    this.#flush(); // a new capture may need another downscale factor
  }

  #applyTracks() {
    for (const { sender, receiver } of this.#pc.getTransceivers()) {
      sender.replaceTrack(this.#tracks[receiver.track.kind] ?? null).catch(() => {});
    }
  }

  #transceiver(kind) {
    return this.#pc.getTransceivers().find((t) => t.receiver.track.kind === kind);
  }

  /** The video encoder settings (see `profileOf` in quality.js): on or off, resolution,
   *  frame rate, bitrate cap. Applied as soon as the connection is up and whenever they
   *  change; never renegotiates. Several changes in a row collapse into the last one. */
  applyProfile(profile) {
    this.#profile = profile;
    this.#flush();
  }

  async #flush() {
    if (this.state !== 'connected' || !this.#profile) return;
    if (this.#busy) { this.#dirty = true; return; }
    this.#busy = true;
    try {
      do {
        this.#dirty = false;
        await this.#write(this.#profile);
      } while (this.#dirty && this.state === 'connected');
    } finally { this.#busy = false; }
  }

  /** Not every browser lets us tune this: it is an optimisation, so failures are ignored.
   *  A browser that rejects `degradationPreference` is asked again without it. */
  async #write(profile) {
    const sender = this.#transceiver('video')?.sender;
    if (!sender) return;
    for (const withPreference of [!this.#noPreference, false]) {
      try {
        const params = sender.getParameters();
        params.encodings = params.encodings?.length ? params.encodings : [{}];
        const [encoding] = params.encodings;
        encoding.active = profile.active;
        if (profile.active) {
          encoding.maxBitrate = profile.bps;
          encoding.maxFramerate = profile.fps;
          encoding.scaleResolutionDownBy = this.#scaleFor(profile.h);
          if (withPreference) params.degradationPreference = DEGRADATION[profile.kind];
        }
        await sender.setParameters(params);
        return;
      } catch { this.#noPreference = true; }
    }
  }

  /** How much to shrink the capture to get `height` pixels (never enlarges). */
  #scaleFor(height) {
    const captured = this.#tracks.video?.getSettings?.().height;
    return captured > height ? captured / height : 1;
  }

  /** Voice outranks video when the link is short of bandwidth. */
  async #prioritizeAudio() {
    try {
      const sender = this.#transceiver('audio')?.sender;
      const params = sender.getParameters();
      params.encodings = params.encodings?.length ? params.encodings : [{}];
      params.encodings[0].priority = 'high';
      params.encodings[0].networkPriority = 'high';
      await sender.setParameters(params);
    } catch { /* optional */ }
  }

  /** One reading of the connection's statistics (see `readStats`), null if unavailable. */
  async sample() {
    if (this.state !== 'connected' || typeof this.#pc.getStats !== 'function') return null;
    try { return readStats(await this.#pc.getStats()); } catch { return null; }
  }

  close() {
    if (this.state === 'closed') return;
    this.state = 'closed';
    try { this.#pc.close(); } catch { /* already closed */ }
    this.emit('close');
  }
}
