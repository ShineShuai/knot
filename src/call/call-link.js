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
  #pc; #gatherMs; #tracks = { audio: null, video: null }; #maxVideo = null;

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
        this.#applyVideoLimit();
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
  }

  #applyTracks() {
    for (const { sender, receiver } of this.#pc.getTransceivers()) {
      sender.replaceTrack(this.#tracks[receiver.track.kind] ?? null).catch(() => {});
    }
  }

  /** Cap the video bitrate (bits per second); applied as soon as the connection is up. */
  limitVideo(bitsPerSecond) {
    this.#maxVideo = bitsPerSecond;
    this.#applyVideoLimit();
  }

  async #applyVideoLimit() {
    if (this.state !== 'connected' || !this.#maxVideo) return;
    const video = this.#pc.getTransceivers().find((t) => t.receiver.track.kind === 'video');
    try {
      const params = video.sender.getParameters();
      params.encodings = params.encodings?.length ? params.encodings : [{}];
      params.encodings[0].maxBitrate = this.#maxVideo;
      await video.sender.setParameters(params);
    } catch { /* not every browser lets us tune this: it is only an optimisation */ }
  }

  close() {
    if (this.state === 'closed') return;
    this.state = 'closed';
    try { this.#pc.close(); } catch { /* already closed */ }
    this.emit('close');
  }
}
