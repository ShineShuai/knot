// Hybrid logical clock: wall-clock milliseconds plus a counter, so stamps are
// unique per node, monotonic, and roughly ordered across nodes.
export const MAX_FUTURE_MS = 10 * 60 * 1000;

export const compareStamps = (a, b) => a.ms - b.ms || a.c - b.c;

export class HLC {
  ms = 0;
  c = 0;
  #now;

  #base;

  /** `counterBase`: where the counter starts in each new millisecond. A linked device uses a
   *  high one, so it cannot make the same id as the main device in the same millisecond (both
   *  write as one identity). */
  constructor(now = Date.now, counterBase = 0) {
    this.#now = now;
    this.#base = counterBase;
  }

  /** Stamp for a local event. */
  tick() {
    const t = this.#now();
    if (t > this.ms) { this.ms = t; this.c = this.#base; } else { this.c++; }
    return { ms: this.ms, c: this.c };
  }

  /** Merge a stamp seen from a remote node. Far-future stamps are clamped so a
   *  malicious peer cannot push our clock forward indefinitely. */
  observe(remote) {
    const t = this.#now();
    const rms = Math.min(remote.ms, t + MAX_FUTURE_MS);
    const ms = Math.max(t, this.ms, rms);
    if (ms === this.ms && ms === rms) this.c = Math.max(this.c, remote.c) + 1;
    else if (ms === this.ms) this.c++;
    else if (ms === rms) this.c = remote.c + 1;
    else this.c = 0;
    this.ms = ms;
  }
}
