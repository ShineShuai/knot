// Ordered, de-duplicated message log with a FIFO cap, plus the set arithmetic
// used by history sync ("what do you have?" / "here is what you lack").
import { compareStamps } from '../util/hlc.js';

const byStamp = (a, b) => compareStamps(a, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const stampOfId = (id) => parseInt(String(id).split('-')[0], 36) || 0;

export class MessageLog {
  #byId = new Map();
  #cap;

  constructor(cap = 1000) { this.#cap = cap; }

  get size() { return this.#byId.size; }
  has(id) { return this.#byId.has(id); }

  /** @returns {boolean} false if the message was already present */
  add(env) {
    if (this.#byId.has(env.id)) return false;
    this.#byId.set(env.id, env);
    return true;
  }

  /** Drop the oldest messages beyond the cap; returns the removed envelopes. */
  trim() {
    const excess = this.#byId.size - this.#cap;
    if (excess <= 0) return [];
    const removed = this.list().slice(0, excess);
    for (const e of removed) this.#byId.delete(e.id);
    return removed;
  }

  /** All messages, oldest first. */
  list() { return [...this.#byId.values()].sort(byStamp); }

  recentIds(n) { return this.list().slice(-n).map((e) => e.id); }

  /** Messages the other side lacks, given the ids it reported (`theirFull`: its
   *  report was truncated to a window, so older messages are out of scope). */
  missingFor(theirIds, theirFull, limit = 500) {
    const have = new Set(theirIds);
    const floor = theirFull && theirIds.length ? Math.min(...theirIds.map(stampOfId)) : 0;
    return this.list().filter((e) => !have.has(e.id) && e.ms >= floor).slice(-limit);
  }
}
