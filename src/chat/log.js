// Ordered, de-duplicated message log with a FIFO cap, plus the set arithmetic
// used by history sync ("what do you have?" / "here is what you lack").
import { compareStamps } from '../util/hlc.js';
import { ADMIN_KINDS, authorIdOf } from './envelope.js';

const byStamp = (a, b) => compareStamps(a, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const stampOfId = (id) => parseInt(String(id).split('-')[0], 36) || 0;

export class MessageLog {
  #byId = new Map();
  #gone = new Map(); // id of a deleted message -> the 'del' envelope that removed it
  #cap;

  constructor(cap = 1000) { this.#cap = cap; }

  get size() { return this.#byId.size; }
  has(id) { return this.#byId.has(id) || this.#gone.has(id); }
  get(id) { return this.#byId.get(id) ?? null; }
  isGone(id) { return this.#gone.has(id); }

  /** @returns {boolean} false if the message was already present (or already deleted) */
  add(env) {
    if (this.has(env.id)) return false;
    if (env.kind === 'del' && this.#byId.get(env.body.id)?.kind !== 'del') {
      this.#byId.delete(env.body.id); // the content is dropped, the deletion is remembered
      this.#gone.set(env.body.id, env);
    }
    this.#byId.set(env.id, env);
    return true;
  }

  /** Drop the oldest messages beyond the cap; returns the removed envelopes. */
  trim() {
    const excess = this.#byId.size - this.#cap;
    if (excess <= 0) return [];
    const removed = this.list().filter((e) => !ADMIN_KINDS.includes(e.kind)).slice(0, excess);
    for (const e of removed) {
      this.#byId.delete(e.id);
      if (e.kind === 'del') this.#gone.delete(e.body.id);
    }
    return removed;
  }

  /** All envelopes, oldest first (what history sync works with). */
  list() { return [...this.#byId.values()].sort(byStamp); }

  /** What to show, oldest first: messages, and in place of each deleted one a stub
   *  { id, kind: 'gone', ms, c, by, name, at } saying who deleted it (and when). */
  timeline() {
    const items = [...this.#byId.values()].filter((e) => e.kind !== 'del');
    for (const [id, del] of this.#gone) {
      const [ms, c] = id.split('-').map((part) => parseInt(part, 36) || 0);
      items.push({ id, kind: 'gone', ms, c, by: authorIdOf(del), name: del.name, at: del.ms });
    }
    return items.sort(byStamp);
  }

  recentIds(n) { return this.list().slice(-n).map((e) => e.id); }

  /** Messages the other side lacks, given the ids it reported (`theirFull`: its
   *  report was truncated to a window, so older messages are out of scope). */
  missingFor(theirIds, theirFull, limit = 500) {
    const have = new Set(theirIds);
    const floor = theirFull && theirIds.length ? Math.min(...theirIds.map(stampOfId)) : 0;
    return this.list().filter((e) => !have.has(e.id) && e.ms >= floor).slice(-limit);
  }
}
