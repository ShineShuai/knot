// Which messages this device has shown to its user: a stamp, kept per room. Messages from
// others that are newer than it are "unread".
import { Emitter } from '../util/emitter.js';
import { compareStamps } from '../util/hlc.js';
import { authorIdOf } from './envelope.js';

const UNREAD_KINDS = ['text', 'reply', 'file']; // what counts as a message to catch up on

/** Events: 'change' (the unread count may have changed), 'read' (stamp: this device moved the
 *  mark forward; not fired for a mark that came from another of our devices). */
export class ReadMarks extends Emitter {
  #read = { ms: 0, c: 0 }; // stamp of the newest message seen on this device

  /** `isMine(authorId)`: is this author us (any of our devices)? */
  constructor({ kv, roomId, log, isMine }) {
    super();
    Object.assign(this, { kv, roomId, log, isMine });
  }

  get #key() { return `read:${this.roomId}`; }

  #newestStamp() {
    const last = this.log.list().at(-1);
    return last ? { ms: last.ms, c: last.c } : { ms: 0, c: 0 };
  }

  async load() {
    const mark = await this.kv.get(this.#key);
    this.#read = mark ?? this.#newestStamp(); // first run: what is here counts as read
    if (!mark) await this.kv.put(this.#key, this.#read).catch(() => {});
  }

  /** The newest message stamp seen, on this device or (see `advance`) on another of ours. */
  get stamp() { return { ...this.#read }; }

  /** Another of our devices has read up to `stamp`: the mark only ever moves forward. */
  async advance(stamp) {
    if (compareStamps(stamp, this.#read) <= 0) return;
    this.#read = { ms: stamp.ms, c: stamp.c };
    this.emit('change');
    await this.kv.put(this.#key, this.#read).catch(() => {});
  }

  isUnread(env) {
    return UNREAD_KINDS.includes(env.kind) && !this.isMine(authorIdOf(env))
      && compareStamps(env, this.#read) > 0;
  }

  /** Messages from others that this device has not shown to its user yet. */
  get count() { return this.log.where((e) => this.isUnread(e)).length; }

  /** The user has seen everything up to now (they are looking at this room). */
  async markRead() {
    const newest = this.#newestStamp();
    if (compareStamps(newest, this.#read) <= 0) return;
    this.#read = newest;
    this.emit('change');
    this.emit('read', { ...newest });
    await this.kv.put(this.#key, newest).catch(() => {});
  }
}
