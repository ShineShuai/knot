// A mesh call for one room: everyone in the call holds one CallLink to everyone else.
//
// Presence and SDP travel as {t:'call'} frames over the room's authenticated chat links
// (the room hands us `send`), so only members take part and every media connection is tied
// to a known identity. Nothing here touches the brokers or the message log: who is in a call
// is ephemeral.
//
// Frames (`k`):  in {a,v,s} I am in the call; a/v: microphone / video (camera or screen) are
//                           on; s: the video is a shared screen
//                out        I left
//                who        who is in the call? (answered with `in`; sent when a link is ready,
//                           because a frame sent before the other side counts us as a member
//                           is dropped)
//                want {h}   how tall (pixels) you show my video; 0: not at all. The sender
//                           never encodes more than that (and pauses at 0)
//                pause {on} I stopped sending you video because the network cannot carry it
//                offer/answer {sid, sdp}   the peer with the smaller id always offers
// Events: 'change' (anyone joined, left, muted, connected...)
import { Emitter } from '../util/emitter.js';
import { randomBytes, toB64u } from '../util/bytes.js';
import { CallLink, validSdp } from './call-link.js';
import { browserMedia } from './media.js';
import {
  LinkQuality, MAX_WANT, QualityGroup, bitrate, ceiling, parseWant, profileOf, topRung,
} from './quality.js';

const MAX_TRIES = 6;
const MAX_SID = 32;
const ADAPT_MS = 2000; // how often every connection is measured and its video settings reviewed

const everyMs = (fn, ms) => {
  const timer = setInterval(fn, ms);
  timer.unref?.();
  return () => clearInterval(timer);
};

export class CallManager extends Emitter {
  joined = false;
  /** peer id -> { a, v } for everyone known to be in a call (whether or not we are). */
  members = new Map();

  #links = new Map();  // peer id -> { link, sid, offerer, answered, q, rung, paused }
  #demand = new Map(); // peer id -> tile height they show our video at (their `want`)
  #want = new Map();   // peer id -> tile height we show theirs at (what we told them)
  #paused = new Set(); // peers that stopped sending us video because of the network
  #up = new Set();     // peers we can signal to right now
  #tries = new Map();  // peer id -> failed connection attempts in a row
  #chains = new Map(); // peer id -> promise: one peer's negotiation steps run in order
  #timers = new Set();
  #audio = null; #video = null; #screen = null; #localStream = null;
  #mic = { track: null, stream: null };
  #generation = 0; #joining = false; #adapting = false;
  #aloneSince = null; // when the last other person left (null: not alone, or not in the call)
  #sentVideo = null; #stopAdapt = null; #group = new QualityGroup();
  #send; #opts; #media; #now; #every;

  /**
   * send(peerId, frame) -> boolean   deliver a frame (without `t`) to one peer
   * iceServers() -> RTCIceServer[]
   * settings: callMaxParticipants, callRetryMs, gatherTimeoutMs, connectTimeoutMs
   * RTC, Stream, media, now, every: injectable browser pieces (tests)
   */
  constructor({
    selfId, send, iceServers, settings, media = browserMedia,
    RTC = globalThis.RTCPeerConnection, Stream = globalThis.MediaStream,
    now = () => performance.now(), every = everyMs,
  }) {
    super();
    this.selfId = selfId;
    this.#send = send;
    this.#opts = { iceServers, settings, RTC, Stream };
    this.#media = media;
    this.#now = now;
    this.#every = every;
  }

  /** False on insecure pages and browsers without WebRTC or media capture. */
  get supported() { return !!this.#opts.RTC && this.#media.available(); }
  get max() { return this.#opts.settings.callMaxParticipants; }
  /** Our camera, for the self view (null when it is off). */
  get localStream() { return this.#localStream; }
  /** Our microphone as a stream (null without one); it measures our own voice, nothing is sent. */
  get micStream() {
    if (this.#mic.track !== this.#audio) {
      this.#mic = {
        track: this.#audio, stream: this.#audio ? new this.#opts.Stream([this.#audio]) : null,
      };
    }
    return this.#mic.stream;
  }

  /** Our microphone / camera / screen state (`v`: the camera is on; `s`: we share the screen). */
  get local() { return { a: !!this.#audio?.enabled, v: !!this.#video, s: !!this.#screen }; }

  /** Can this browser share a screen? (Not phones.) */
  get canShare() { return !!this.#media.canShare?.(); }

  /** Everyone else in the call, in a stable order. state: connected | connecting | waiting */
  get participants() {
    return [...this.members].sort(([x], [y]) => (x < y ? -1 : 1)).map(([id, { a, v, s }]) => {
      const link = this.#links.get(id)?.link;
      return {
        id, a, v, s, stream: link?.stream ?? null, state: link?.state ?? 'waiting',
        paused: this.#paused.has(id), // they hold their video back for the network
      };
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
      this.#stopAdapt = this.#every(() => { this.checkAlone(); return this.adapt(); }, ADAPT_MS);
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
    this.#aloneSince = null;
    this.#stopAdapt?.();
    this.#stopAdapt = null;
    this.#broadcast({ k: 'out' });
    for (const id of [...this.#links.keys()]) this.#drop(id);
    this.#demand.clear();
    this.#want.clear();
    this.#paused.clear();
    this.#group = new QualityGroup();
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#tries.clear();
    this.#audio?.stop();
    this.#audio = null;
    this.#screen?.stop();
    this.#screen = null;
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

  /** Share the screen (or a window or tab) instead of the camera, or go back to the camera.
   *  Resolves to whether we share now; a cancelled or refused picker changes nothing. */
  async setScreen(on) {
    if (!this.joined) return false;
    if (on && !this.#screen) {
      let track = null;
      try { track = await this.#media.getScreen(); } catch { return false; }
      if (!this.joined) { track.stop(); return false; } // we left while the browser was asking
      // The browser's own "stop sharing" button ends the track.
      track.addEventListener?.('ended', () => track === this.#screen && this.setScreen(false));
      this.#screen = track;
    } else if (!on && this.#screen) {
      this.#screen.stop();
      this.#screen = null;
    }
    this.#refreshLocal();
    this.#applyTracks();
    this.#publish();
    return !!this.#screen;
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

  /** What we send as video: the screen if we share it, else the camera. */
  #sending() { return this.#screen ?? this.#video; }

  #setVideo(track) {
    this.#video?.stop();
    this.#video = track;
    this.#refreshLocal();
  }

  #refreshLocal() {
    const track = this.#sending();
    this.#localStream = track ? new this.#opts.Stream([track]) : null;
  }

  #state() {
    const { a, s } = this.local;
    return { k: 'in', a, v: !!this.#sending(), s };
  }

  #publish() {
    this.#broadcast(this.#state());
    this.emit('change');
  }

  #applyTracks() {
    const video = this.#sending();
    const changed = video !== this.#sentVideo; // camera <-> screen: new size, new settings
    this.#sentVideo = video;
    for (const entry of this.#links.values()) {
      entry.link.setTracks({ audio: this.#audio, video });
      if (changed) entry.rung = -1;
    }
    this.#retune();
  }

  #broadcast(frame) { for (const id of this.#up) this.#send(id, frame); }

  /** Leave once nobody else has been in the call for `callAloneMs` (a timer calls this) and
   *  emit 'alone': nobody is left to hear us, yet the devices and the uplink stay held. */
  checkAlone() {
    if (!this.joined || this.members.size) { this.#aloneSince = null; return; }
    const limit = this.#opts.settings.callAloneMs;
    this.#aloneSince ??= this.#now();
    if (!(limit > 0) || this.#now() - this.#aloneSince < limit) return;
    this.leave();
    this.emit('alone');
  }

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
    this.#demand.delete(id);
    this.#want.delete(id);
    this.#drop(id);
    if (this.members.delete(id)) this.emit('change');
  }

  /** A {t:'call'} frame from a member. Malformed or out-of-place frames are ignored. */
  onFrame(id, m) {
    if (m?.k === 'in') {
      this.members.set(id, { a: m.a === true, v: m.v === true, s: m.s === true });
      this.emit('change');
      this.#reconcile();
      this.#tell(id); // they may have lost what we last said about their video
    } else if (m?.k === 'who') {
      if (this.joined) this.#send(id, this.#state());
    } else if (m?.k === 'out') {
      this.#demand.delete(id);
      this.#want.delete(id);
      this.#drop(id);
      if (this.members.delete(id)) this.emit('change');
    } else if (m?.k === 'want') {
      const h = parseWant(m.h);
      if (h === undefined || !this.joined || !this.members.has(id)) return;
      this.#demand.set(id, h);
      this.#retune();
    } else if (m?.k === 'pause') {
      if (!this.members.has(id)) return;
      const was = this.#paused.has(id);
      if (m.on === true) this.#paused.add(id); else this.#paused.delete(id);
      if (was !== this.#paused.has(id)) this.emit('change');
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
    link.setTracks({ audio: this.#audio, video: this.#sending() });
    const entry = {
      link, sid, offerer, answered: false, q: null, rung: -1, paused: false,
      sample: null, sampledAt: null, bps: null,
    };
    this.#links.set(id, entry);
    link.on('connected', () => { this.#tries.delete(id); this.emit('change'); });
    link.on('close', () => this.#closed(id, entry));
    this.#retune();
    this.emit('change');
    return entry;
  }

  /** Close one peer's connection without it counting as a failure. */
  #drop(id) {
    const entry = this.#links.get(id);
    if (!entry) return;
    this.#links.delete(id);
    this.#paused.delete(id);
    entry.link.close();
    this.#retune();
    this.emit('change');
  }

  /** A connection died by itself: the offering side tries again, with growing pauses. */
  #closed(id, entry) {
    if (this.#links.get(id) !== entry) return;
    this.#links.delete(id);
    this.#paused.delete(id);
    this.#retune();
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

  // ---- video quality ------------------------------------------------------------------
  // Each connection sends at the highest rung (see quality.js) that the head count, what the
  // receiver shows, and the health we measured all allow; a receiver that does not show our
  // video gets none. Only encoder settings change: nothing is renegotiated.

  /** Tell `id` how tall we show their video (pixels; 0: not at all). The call window does
   *  this as tiles resize, hide and show. */
  setWant(id, height) {
    const h = Math.max(0, Math.min(MAX_WANT, Math.round(height)));
    if (!Number.isFinite(h) || this.#want.get(id) === h) return;
    this.#want.set(id, h);
    this.#tell(id);
  }

  #tell(id) {
    const h = this.#want.get(id);
    if (this.joined && h !== undefined && this.#up.has(id)) this.#send(id, { k: 'want', h });
  }

  /** Measure every connection once and review its video settings (a timer does this). The
   *  connections share one uplink, so a group decides who steps down or up first. */
  async adapt() {
    if (this.#adapting || !this.#links.size) return;
    this.#adapting = true;
    const at = this.#now();
    try {
      const taken = await Promise.all(
        [...this.#links].map(async ([id, entry]) => [id, entry, await entry.link.sample()]),
      );
      const items = [];
      for (const [id, entry, sample] of taken) {
        if (!sample || this.#links.get(id) !== entry || !entry.q) continue;
        entry.bps = entry.sample && bitrate(entry.sample, sample, (at - entry.sampledAt) / 1000);
        entry.sample = sample;
        entry.sampledAt = at;
        items.push({
          id, entry, q: entry.q, sample, ceil: this.#ceilingFor(id, entry),
          want: this.#demand.get(id),
        });
      }
      if (!this.#sending()) return; // nothing is sent: nothing to learn
      const rungs = this.#group.review(items, at);
      items.forEach(({ id, entry, ceil }, i) => this.#setRung(id, entry, rungs[i], ceil));
    } finally { this.#adapting = false; }
  }

  /** One row per connection, for the diagnostics: what we send and measured, what is asked. */
  quality() {
    return [...this.#links].map(([id, entry]) => {
      const { q, sample: s } = entry;
      return {
        id, state: entry.link.state, kind: q?.kind ?? null, rung: entry.rung,
        level: q?.level ?? null, top: q ? topRung(q.kind) : null,
        paused: entry.paused, pausedByPeer: this.#paused.has(id),
        demand: this.#demand.get(id) ?? null, want: this.#want.get(id) ?? null,
        send: s && {
          kbps: entry.bps == null ? null : Math.round(entry.bps / 1000),
          fps: s.fps, w: s.w, h: s.h, loss: s.loss, rtt: s.rtt, limit: s.limit,
          available: s.available,
        },
        recv: s?.recv ?? null,
      };
    });
  }

  #ceilingFor(id, entry) {
    return ceiling(entry.q.kind, this.#links.size + 1, this.#demand.get(id));
  }

  /** Everything but health changed (people, tiles, camera or screen): recompute. */
  #retune() {
    const kind = this.#screen ? 'screen' : 'camera';
    for (const [id, entry] of this.#links) {
      if (entry.q?.kind !== kind) { entry.q = new LinkQuality(kind, this.#now()); entry.rung = -1; }
      const ceil = this.#ceilingFor(id, entry);
      this.#setRung(id, entry, entry.q.rung(ceil), ceil);
    }
  }

  #setRung(id, entry, rung, ceil) {
    const paused = rung === 0 && ceil > 0; // dropped for the network, not because unseen
    if (paused !== entry.paused) {
      entry.paused = paused;
      this.#send(id, { k: 'pause', on: paused });
    }
    if (rung === entry.rung) return;
    entry.rung = rung;
    entry.link.applyProfile(profileOf(entry.q.kind, rung));
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
