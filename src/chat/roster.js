// Who belongs to a room, decided by its owner. Membership is a hash-free chain of signed
// admin envelopes that every peer replays the same way:
//   admit    { id, name, prev }   the owner lets `id` in
//   revoke   { id, prev }         the owner removes `id`
//   transfer { to, prev }         the owner hands the room to member `to`
// `prev` is the id of the previous link ('' for the first), so the order does not depend on
// anyone's clock: a removed owner cannot backdate, and a second envelope with an old
// `prev` is a fork and is refused. Only the current owner's signature extends the chain.
// Envelopes must be signature-checked (verifyEnvelope) before they are applied here.
import { ADMIN_KINDS, authorIdOf } from './envelope.js';

const WAIT_LIMIT = 64; // envelopes received before their predecessor

export { ADMIN_KINDS };

export class Roster {
  founder; // whoever created the room; the chain starts with their signature
  owner;
  head = '';
  chain = []; // applied envelopes, in order
  members = new Map(); // id -> { name } for everyone except the owner
  revoked = new Set();
  #applied = new Set();
  #waiting = new Map(); // prev id -> envelope that follows it

  constructor(founder) { this.founder = founder; this.owner = founder; }

  isMember(id) { return id === this.owner || this.members.has(id); }

  /** Everything we hold, applied ones in order, then those still missing a predecessor
   *  (so that a peer who has the missing part can complete the chain). */
  envs() { return [...this.chain, ...this.#waiting.values()]; }

  /** Apply one admin envelope. Returns the envelopes that took effect (this one and any
   *  that were waiting for it), or [] if it was refused or must wait for a predecessor. */
  apply(env) {
    if (this.#applied.has(env.id)) return [];
    const { prev } = env.body;
    if (prev !== this.head) {
      if (prev === '' || this.#applied.has(prev)) return []; // forks settled history
      if (this.#waiting.size < WAIT_LIMIT && !this.#waiting.has(prev)) this.#waiting.set(prev, env);
      return [];
    }
    if (!this.#valid(env)) return [];
    const applied = [env];
    this.#commit(env);
    for (let next = this.#waiting.get(env.id); next; next = this.#waiting.get(next.id)) {
      this.#waiting.delete(next.body.prev);
      if (!this.#valid(next)) break;
      this.#commit(next);
      applied.push(next);
    }
    return applied;
  }

  /** Rebuild from stored envelopes, in any order. */
  load(envs) {
    const todo = envs.filter((e) => ADMIN_KINDS.includes(e.kind));
    for (let progress = true; progress;) {
      progress = false;
      for (const env of todo) if (this.apply(env).length) progress = true;
    }
  }

  #valid(env) {
    if (authorIdOf(env) !== this.owner) return false;
    const { body } = env;
    if (env.kind === 'revoke') return body.id !== this.owner;
    if (env.kind === 'transfer') return this.members.has(body.to);
    return env.kind === 'admit';
  }

  #commit(env) {
    const { body } = env;
    if (env.kind === 'admit') {
      if (body.id !== this.owner) this.members.set(body.id, { name: body.name });
      this.revoked.delete(body.id);
    } else if (env.kind === 'revoke') {
      this.members.delete(body.id);
      this.revoked.add(body.id);
    } else { // transfer: the old owner stays a member
      this.members.delete(body.to);
      this.members.set(this.owner, { name: env.name });
      this.owner = body.to;
    }
    this.chain.push(env);
    this.head = env.id;
    this.#applied.add(env.id);
  }
}
