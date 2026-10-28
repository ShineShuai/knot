// A mesh call for one room: everyone in the call holds one CallLink to everyone else.
//
// Presence and SDP travel as {t:'call'} frames over the room's authenticated chat links
// (the room hands us `send`), so only members take part and every media connection is tied
// to a known identity. Nothing here touches the brokers or the message log: who is in a call
// is ephemeral.
//
// Frames (`k`):  in {a,v}   I am in the call; a/v: microphone / camera are on
//                out        I left
//                who        who is in the call? (answered with `in`; sent when a link is ready,
//                           because a frame sent before the other side counts us as a member
//                           is dropped)
//                offer/answer {sid, sdp}   the peer with the smaller id always offers
// Events: 'change' (anyone joined, left, muted, connected...)
import { Emitter } from '../util/emitter.js';
import { randomBytes, toB64u } from '../util/bytes.js';
import { CallLink, validSdp } from './call-link.js';
import { browserMedia } from './media.js';

const MAX_TRIES = 6;
const MAX_SID = 32;
/** Every sender encodes once per receiver, so the more people, the less each stream gets. */
const videoBitrate = (people) => (people <= 2 ? 1_000_000 : people <= 4 ? 450_000 : 250_000);

export class CallManager extends Emitter {
  joined = false;
  /** peer id -> { a, v } for everyone known to be in a call (whether or not we are). */
  members = new Map();

  #links = new Map();  // peer id -> { link, sid, offerer, answered }
  #up = new Set();     // peers we can signal to right now
  #tries = new Map();  // peer id -> failed connection attempts in a row
  #chains = new Map(); // peer id -> promise: one peer's negotiation steps run in order
  #timers = new Set();
  #audio = null; #video = null; #localStream = null;
  #generation = 0; #joining = false;
  #send; #opts; #media;

  /**
   * send(peerId, frame) -> boolean   deliver a frame (without `t`) to one peer
   * iceServers() -> RTCIceServer[]
   * settings: callMaxParticipants, callRetryMs, gatherTimeoutMs, connectTimeoutMs
   * RTC, Stream, media: injectable browser pieces (tests)
   */
  constructor({
    selfId, send, iceServers, settings, media = browserMedia,
    RTC = globalThis.RTCPeerConnection, Stream = globalThis.MediaStream,
  }) {
    super();
    this.selfId = selfId;
    this.#send = send;
    this.#opts = { iceServers, settings, RTC, Stream };
    this.#media = media;
  }

  /** False on insecure pages and browsers without WebRTC or media capture. */
  get supported() { return !!this.#opts.RTC && this.#media.available(); }
  get max() { return this.#opts.settings.callMaxParticipants; }
  /** Our camera, for the self view (null when it is off). */
  get localStream() { return this.#localStream; }
  /** Our microphone / camera state. */
  get local() { return { a: !!this.#audio?.enabled, v: !!this.#video }; }

  /** Everyone else in the call, in a stable order. state: connected | connecting | waiting */
  get participants() {
    return [...this.members].sort(([x], [y]) => (x < y ? -1 : 1)).map(([id, { a, v }]) => {
      const link = this.#links.get(id)?.link;
      return { id, a, v, stream: link?.stream ?? null, state: link?.state ?? 'waiting' };
    });
  }

  // ---- us -----------------------------------------------------------------------------

  /**
   * Enter the call with the microphone (and the camera, if asked). A device that is refused
   * or missing is not fatal: we still join and listen. Resolves to what we actually got.
   */
  async join({ video = false } = {}) {
    if (this.joined || this.#joining) return this.#devices();
    if (!this.supported) throw new Error('Calls need a secure page and a recent browser');
    if (this.members.size >= this.max) throw new Error('The call is full');
    this.#joining = true;
    const generation = this.#generation;
    try {
      const audio = await this.#acquire('audio');
      const camera = video ? await this.#acquire('video') : null;
      if (generation !== this.#generation) { // left or stopped while the browser was asking
        for (const track of [audio, camera]) track?.stop();
        return { audio: false, video: false };
      }
      this.#audio = audio;
      this.#setVideo(camera);
      this.joined = true;
      this.#broadcast(this.#state());
      this.#reconcile();
      this.emit('change');
      return this.#devices();
    } finally { this.#joining = false; }
  }

  /** Leave: tell everyone, close every connection, release the devices. */
  leave() {
    this.#generation++;
    if (!this.joined) return;
    this.joined = false;
    this.#broadcast({ k: 'out' });
    for (const id of [...this.#links.keys()]) this.#drop(id);
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#tries.clear();
    this.#audio?.stop();
    this.#audio = null;
    this.#setVideo(null);
    this.emit('change');
  }

  /** Microphone on or off; resolves to the new state. */
  async setAudio(on) {
    if (!this.joined) return false;
    if (on && !this.#audio) {
      this.#audio = await this.#acquire('audio');
      this.#applyTracks();
    }
    if (this.#audio) this.#audio.enabled = on;
    this.#publish();
    return this.local.a;
  }

  /** Camera on or off (off releases the device, so its light goes out); resolves to the state. */
  async setVideo(on) {
    if (!this.joined) return false;
    if (on && !this.#video) this.#setVideo(await this.#acquire('video'));
    else if (!on) this.#setVideo(null);
    this.#applyTracks();
    this.#publish();
    return !!this.#video;
  }

  #devices() { return { audio: !!this.#audio, video: !!this.#video }; }

  async #acquire(kind) {
    let track = null;
    try { track = await this.#media.getTrack(kind); } catch { return null; }
    // Unplugged or revoked mid-call: carry on without it.
    track.addEventListener?.('ended', () => {
      if (track === this.#audio) { this.#audio = null; this.#applyTracks(); this.#publish(); }
      if (track === this.#video) this.setVideo(false);
    });
    return track;
  }

  #setVideo(track) {
    this.#video?.stop();
    this.#video = track;
    this.#localStream = track ? new this.#opts.Stream([track]) : null;
  }

  #state() { return { k: 'in', a: this.local.a, v: this.local.v }; }

  #publish() {
    this.#broadcast(this.#state());
    this.emit('change');
  }

  #applyTracks() {
    for (const { link } of this.#links.values()) {
      link.setTracks({ audio: this.#audio, video: this.#video });
    }
  }

  #broadcast(frame) { for (const id of this.#up) this.#send(id, frame); }

  // ---- peers (called by the room) ------------------------------------------------------

  /** A chat link to a member is ready for signaling. */
  peerUp(id) {
    this.#up.add(id);
    this.#send(id, { k: 'who' });
  }

  /** That link is gone: so is the peer's place in the call (they announce again on return). */
  peerDown(id) {
    this.#up.delete(id);
    this.#tries.delete(id);
    this.#drop(id);
    if (this.members.delete(id)) this.emit('change');
  }

  /** A {t:'call'} frame from a member. Malformed or out-of-place frames are ignored. */
  onFrame(id, m) {
    if (m?.k === 'in') {
      this.members.set(id, { a: m.a === true, v: m.v === true });
      this.emit('change');
      this.#reconcile();
    } else if (m?.k === 'who') {
      if (this.joined) this.#send(id, this.#state());
    } else if (m?.k === 'out') {
      this.#drop(id);
      if (this.members.delete(id)) this.emit('change');
    } else if (m?.k === 'offer' || m?.k === 'answer') {
      this.#serial(id, () => this.#negotiate(id, m));
    }
  }

  // ---- connections --------------------------------------------------------------------

  /** Offer to everyone in the call whose id is larger than ours (they answer, never offer). */
  #reconcile() {
    if (!this.joined) return;
    for (const id of this.members.keys()) {
      if (this.selfId < id) this.#serial(id, () => this.#dial(id));
    }
  }

  async #dial(id) {
    if (!this.joined || this.#links.has(id) || !this.#up.has(id) || this.#full()) return;
    const sid = toB64u(randomBytes(6));
    const entry = this.#open(id, sid, true);
    try {
      const sdp = await entry.link.createOffer();
      if (this.#links.get(id) === entry) this.#send(id, { k: 'offer', sid, sdp });
    } catch { entry.link.close(); }
  }

  async #negotiate(id, { k, sid, sdp }) {
    const known = this.joined && this.members.has(id);
    if (!known || typeof sid !== 'string' || sid.length > MAX_SID || !validSdp(sdp)) return;
    if (k === 'offer') {
      if (this.selfId < id || (!this.#links.has(id) && this.#full())) return;
      this.#drop(id); // a new offer replaces a connection that died on our side
      const entry = this.#open(id, sid, false);
      try {
        const answer = await entry.link.acceptOffer(sdp);
        if (this.#links.get(id) === entry) this.#send(id, { k: 'answer', sid, sdp: answer });
      } catch { entry.link.close(); }
      return;
    }
    const entry = this.#links.get(id);
    if (entry?.sid !== sid || !entry.offerer || entry.answered) return;
    entry.answered = true;
    try { await entry.link.acceptAnswer(sdp); } catch { entry.link.close(); }
  }

  #open(id, sid, offerer) {
    const { settings, iceServers, RTC, Stream } = this.#opts;
    const link = new CallLink({
      iceServers: iceServers(), gatherTimeoutMs: settings.gatherTimeoutMs,
      connectTimeoutMs: settings.connectTimeoutMs, RTC, Stream,
    });
    link.setTracks({ audio: this.#audio, video: this.#video });
    const entry = { link, sid, offerer, answered: false };
    this.#links.set(id, entry);
    link.on('connected', () => { this.#tries.delete(id); this.emit('change'); });
    link.on('close', () => this.#closed(id, entry));
    this.#tune();
    this.emit('change');
    return entry;
  }

  /** Close one peer's connection without it counting as a failure. */
  #drop(id) {
    const entry = this.#links.get(id);
    if (!entry) return;
    this.#links.delete(id);
    entry.link.close();
    this.#tune();
    this.emit('change');
  }

  /** A connection died by itself: the offering side tries again, with growing pauses. */
  #closed(id, entry) {
    if (this.#links.get(id) !== entry) return;
    this.#links.delete(id);
    this.emit('change');
    const tries = this.#tries.get(id) ?? 0;
    const retry = this.joined && this.selfId < id && this.members.has(id) && tries < MAX_TRIES;
    if (!retry) return;
    this.#tries.set(id, tries + 1);
    const pause = Math.min(this.#opts.settings.callRetryMs * 2 ** tries, 15000);
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      this.#serial(id, () => this.#dial(id));
    }, pause);
    timer.unref?.();
    this.#timers.add(timer);
  }

  #full() { return this.#links.size >= this.max - 1; }

  #tune() {
    const bitrate = videoBitrate(this.#links.size + 1);
    for (const { link } of this.#links.values()) link.limitVideo(bitrate);
  }

  /** Run `step` after the earlier steps for this peer, so offers and answers never overlap. */
  #serial(id, step) {
    const next = (this.#chains.get(id) ?? Promise.resolve()).then(step).catch(
      (err) => console.error('call step failed', err),
    );
    this.#chains.set(id, next);
    next.then(() => this.#chains.get(id) === next && this.#chains.delete(id));
  }
}
