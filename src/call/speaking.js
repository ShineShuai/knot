// Who is speaking right now: each watched audio stream goes through an analyser; a person
// counts as speaking while their loudness is above a threshold, and for a moment after, so
// the highlight does not flicker between words. No audio is played or recorded here.
import { Emitter } from '../util/emitter.js';

export const SPEAKING_LEVEL = 0.03; // loudness (0..1) above which we hear speech
const HANG_MS = 400;                // keep the highlight this long after the last loud moment
const TICK_MS = 40;  // about as long as the window below, so no sound falls between two looks

/** Loudness of a block of 8-bit samples (silence sits at 128): 0 for silence, 1 at full scale. */
export function loudness(bytes) {
  let sum = 0;
  for (const value of bytes) sum += ((value - 128) / 128) ** 2;
  return Math.sqrt(sum / (bytes.length || 1));
}

const audioTrackOf = (stream) => (stream.getAudioTracks
  ? stream.getAudioTracks() : (stream.getTracks?.() ?? []).filter((x) => x.kind === 'audio'))[0];

/** Events: 'change' (someone started or stopped speaking). */
export class SpeakingMeter extends Emitter {
  #ctx = null;
  #nodes = new Map(); // id -> { track, source, analyser, data, loudAt }
  #waiting = new Map(); // id -> stream that has no audio track yet (it arrives a bit later)
  #speaking = new Set();
  #stopTimer = null;
  #Context; #now; #every;

  /** `Context`, `now`, `every(fn, ms) -> stop`: the browser's pieces, replaceable in tests. */
  constructor({
    Context = globalThis.AudioContext ?? globalThis.webkitAudioContext,
    now = () => performance.now(),
    every = (fn, ms) => {
      const timer = setInterval(fn, ms);
      return () => clearInterval(timer);
    },
  } = {}) {
    super();
    this.#Context = Context;
    this.#now = now;
    this.#every = every;
  }

  get supported() { return !!this.#Context; }
  isSpeaking(id) { return this.#speaking.has(id); }
  ids() { return [...new Set([...this.#nodes.keys(), ...this.#waiting.keys()])]; }

  /** Start (or keep) listening to the audio of `stream` for `id`. A stream that has no audio
   *  track yet is checked again at every tick: remote tracks arrive after the stream does. */
  watch(id, stream) {
    if (!this.#Context) return;
    const track = audioTrackOf(stream);
    if (track ? this.#nodes.get(id)?.track === track : this.#waiting.get(id) === stream) return;
    this.unwatch(id);
    if (track) this.#attach(id, stream, track); else this.#waiting.set(id, stream);
    this.#stopTimer ??= this.#every(() => this.tick(), TICK_MS);
  }

  #attach(id, stream, track) {
    try {
      this.#ctx ??= new this.#Context();
      this.#ctx.resume?.()?.catch?.(() => {}); // a context may start suspended
      const analyser = this.#ctx.createAnalyser();
      analyser.fftSize = 2048; // the last ~40 ms of sound
      const source = this.#ctx.createMediaStreamSource(stream);
      source.connect(analyser); // not to the speakers: it only measures
      this.#nodes.set(id, {
        track, source, analyser, data: new Uint8Array(analyser.fftSize), loudAt: -Infinity,
      });
    } catch { /* this browser cannot analyse the stream: no highlight, no harm */ }
  }

  unwatch(id) {
    this.#waiting.delete(id);
    const node = this.#nodes.get(id);
    if (node) {
      try { node.source.disconnect(); } catch { /* already gone */ }
      this.#nodes.delete(id);
      if (this.#speaking.delete(id)) this.emit('change');
    }
    if (!this.#nodes.size && !this.#waiting.size) { this.#stopTimer?.(); this.#stopTimer = null; }
  }

  /** Measure everyone once (the timer does this; tests call it with their own clock). */
  tick(at = this.#now()) {
    for (const [id, stream] of this.#waiting) {
      const track = audioTrackOf(stream);
      if (!track) continue;
      this.#waiting.delete(id);
      this.#attach(id, stream, track);
    }
    let changed = false;
    for (const [id, node] of this.#nodes) {
      node.analyser.getByteTimeDomainData(node.data);
      if (loudness(node.data) > SPEAKING_LEVEL) node.loudAt = at;
      const on = at - node.loudAt < HANG_MS;
      if (on === this.#speaking.has(id)) continue;
      if (on) this.#speaking.add(id); else this.#speaking.delete(id);
      changed = true;
    }
    if (changed) this.emit('change');
  }

  /** The call is over: release the analysers and the audio context. */
  stop() {
    for (const id of this.ids()) this.unwatch(id);
    this.#ctx?.close?.()?.catch?.(() => {});
    this.#ctx = null;
  }
}
