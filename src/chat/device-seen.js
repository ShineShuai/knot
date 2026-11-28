// When each of a person's devices was last online and last synced, kept on this device and told
// to the others over direct links only (docs/devices.md, "The device list"). Plain state, no
// network and no clock of its own: the app feeds it.
import { MAX_FUTURE_MS } from '../util/hlc.js';

const MAX_DEVICES = 64;

export class DeviceSeen {
  #seen = new Map(); // device key -> { ms, pv, direct }
  #synced = new Map(); // device key -> ms we last took state from it
  #own;
  #now;

  /** `own`: this device's key (b64u), which is never listed here. */
  constructor(own, now = Date.now) { [this.#own, this.#now] = [own, now]; }

  /** What was saved (anything: it is checked). */
  load(saved) {
    for (const [pub, v] of Object.entries(saved?.seen ?? {}).slice(0, MAX_DEVICES)) {
      if (v && Number.isFinite(v.ms)) this.#seen.set(pub, { ms: v.ms, pv: v.pv ?? null, direct: !!v.direct });
    }
    for (const [pub, ms] of Object.entries(saved?.synced ?? {}).slice(0, MAX_DEVICES)) {
      if (Number.isFinite(ms)) this.#synced.set(pub, ms);
    }
  }

  toJSON() {
    return { seen: Object.fromEntries(this.#seen), synced: Object.fromEntries(this.#synced) };
  }

  /** Device `pub` was online at `ms`. `direct`: we saw it ourselves, or it said so of itself;
   *  otherwise another device told us. `pv`: its protocol level, where its own word wins over
   *  what others say. A time never moves back, and none is later than the limit for a clock
   *  that runs ahead. True if anything changed. */
  note(pub, ms, { pv = null, direct = false } = {}) {
    if (!pub || pub === this.#own || !Number.isFinite(ms)) return false;
    const at = Math.min(ms, this.#now() + MAX_FUTURE_MS);
    const had = this.#seen.get(pub);
    if (!had) {
      this.#seen.set(pub, { ms: at, pv, direct });
      return true;
    }
    let changed = false;
    if (at > had.ms) [had.ms, had.direct, changed] = [at, direct, true];
    else if (at === had.ms && direct && !had.direct) [had.direct, changed] = [true, true];
    if (pv && (direct || !had.pv) && had.pv !== pv) [had.pv, changed] = [pv, true];
    return changed;
  }

  get(pub) { return this.#seen.get(pub); }

  noteSynced(pub) {
    if (!pub || pub === this.#own) return false;
    this.#synced.set(pub, this.#now());
    return true;
  }

  syncedAt(pub) { return this.#synced.get(pub) ?? null; }

  /** What to tell another device: our own entry on top (`pv`: our protocol level), then ours. */
  frame(pv) {
    const seen = { [this.#own]: { ms: this.#now(), pv } };
    for (const [pub, v] of this.#seen) seen[pub] = { ms: v.ms, ...(v.pv ? { pv: v.pv } : {}) };
    return seen;
  }

  /** What another device told us. Its own entry (`from`) is first-hand, the rest is its word.
   *  Only devices in `known` count. True if anything changed. */
  receive(seen, from, known) {
    if (!seen || typeof seen !== 'object' || Array.isArray(seen)) return false;
    let changed = false;
    for (const [pub, v] of Object.entries(seen).slice(0, MAX_DEVICES)) {
      if (!known.has(pub) || !v || typeof v.ms !== 'number') continue;
      const pv = Number.isInteger(v.pv) && v.pv > 0 ? v.pv : null;
      if (this.note(pub, v.ms, { pv, direct: pub === from })) changed = true;
    }
    return changed;
  }
}
