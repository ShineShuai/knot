// Ordered, de-duplicated message log with a FIFO cap, plus the set arithmetic
// used by history sync ("what do you have?" / "here is what you lack").
import { compareStamps } from '../util/hlc.js';
import { ADMIN_KINDS, authorIdOf } from './envelope.js';

export const byStamp = (a, b) => compareStamps(a, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const stampOfId = (id) => parseInt(String(id).split('-')[0], 36) || 0;

export class MessageLog {
  #byId = new Map();
  #gone = new Map(); // id of a deleted message -> the 'del' envelope that removed it
  #cap;
  #overlay = null;   // edits and reactions, rebuilt after any change

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
    this.#overlay = null;
    return true;
  }

  /** Every envelope that passes `test`, in no particular order. */
  where(test) { return [...this.#byId.values()].filter(test); }

  /** Remove envelopes that something newer replaced (older edits, reactions) or that
   *  belong to a deleted message. They are not remembered: nothing needs them. */
  drop(envs) {
    for (const e of envs) this.#byId.delete(e.id);
    this.#overlay = null;
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
    if (removed.length) this.#overlay = null;
    return removed;
  }

  /** All envelopes, oldest first (what history sync works with). */
  list() { return [...this.#byId.values()].sort(byStamp); }

  /** What to show, oldest first: messages, and in place of each deleted one a stub
   *  { id, kind: 'gone', ms, c, by, name, at } saying who deleted it (and when). Membership
   *  envelopes are included: the UI shows them as short notices ("Bob joined"). */
  timeline() {
    // deletions show as stubs; recovery keys never show; edits and reactions decorate others
    const hidden = ['del', 'recovery', 'edit', 'react'];
    const items = [...this.#byId.values()].filter((e) => !hidden.includes(e.kind));
    for (const [id, del] of this.#gone) {
      const [ms, c] = id.split('-').map((part) => parseInt(part, 36) || 0);
      items.push({ id, kind: 'gone', ms, c, by: authorIdOf(del), name: del.name, at: del.ms });
    }
    return items.sort(byStamp);
  }

  /** What edits and reactions say about messages: { edits: message id -> its latest 'edit'
   *  envelope, reactions: message id -> Map(emoji -> author ids, oldest reaction first) }.
   *  Rebuilt only after the log changed. */
  overlay() {
    if (this.#overlay) return this.#overlay;
    const edits = new Map();
    const reactions = new Map();
    for (const e of this.list()) {
      if (e.kind === 'edit') edits.set(e.body.id, e); // oldest first, so the latest stays
      else if (e.kind === 'react' && e.body.on) {
        const byEmoji = reactions.get(e.body.id) ?? new Map();
        byEmoji.set(e.body.emoji, [...(byEmoji.get(e.body.emoji) ?? []), authorIdOf(e)]);
        reactions.set(e.body.id, byEmoji);
      }
    }
    this.#overlay = { edits, reactions };
    return this.#overlay;
  }

  /** The text to show for a 'text' or 'reply' message, with its latest edit applied. */
  textOf(env) {
    const edit = this.overlay().edits.get(env.id);
    if (edit) return edit.body.text;
    return env.kind === 'reply' ? env.body.text : env.body;
  }

  isEdited(env) { return this.overlay().edits.has(env.id); }

  recentIds(n) { return this.list().slice(-n).map((e) => e.id); }

  /** Messages the other side lacks, given the ids it reported (`theirFull`: its
   *  report was truncated to a window, so older messages are out of scope). */
  missingFor(theirIds, theirFull, limit = 500) {
    const have = new Set(theirIds);
    const floor = theirFull && theirIds.length ? Math.min(...theirIds.map(stampOfId)) : 0;
    return this.list().filter((e) => !have.has(e.id) && e.ms >= floor).slice(-limit);
  }
}
