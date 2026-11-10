// Who belongs to a room, decided by its owner. Membership is a hash-free chain of signed
// admin envelopes that every peer replays the same way:
//   admit    { id, name, role?, prev }  the owner (or a moderator) lets `id` in; the owner's
//                                 `role` 'mod' | 'member' makes `id` a moderator or not
//   revoke   { id, prev }         the owner removes `id`
//   transfer { to, prev }         the owner hands the room to member `to`
//   recovery { key, prev }        the owner registers the public key of a recovery code
//   recover  { to, epoch, prev }  signed by that key: `to` becomes owner, the old one is out
// A revoke may carry `epoch` { n, commit }: from then on the room's broker channel uses
// new keys (see Room), and `commit` is the hash of the secret only members are given.
// `prev` is the id of the previous link ('' for the first), so the order does not depend on
// anyone's clock: a removed owner cannot backdate, and a second envelope with an old
// `prev` is a fork and is refused. Only the owner's signature extends the chain, except that a
// moderator may let someone in (a plain `admit`, never of someone who was removed). Two such
// links can be made at once: then the owner's link wins, and between two moderators' the smaller
// id; the one that loses is withdrawn (see `retracted`) and its author makes it again.
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
  names = new Map(); // id -> the name they were admitted under (kept after removal)
  revoked = new Set();
  mods = new Set(); // moderators: members the owner trusts to let people in and to delete
  retracted = []; // links the last `apply` took back (a moderator's admit that lost a fork)
  recoveryKey = null; // base64url public key of the current recovery code, if any
  epoch = { n: 0, commit: null }; // the latest key rotation the owner announced
  forks = 0; // envelopes refused because the chain had moved on from their `prev`
  #applied = new Set();
  #waiting = new Map(); // prev id -> envelope that follows it

  constructor(founder) { this.founder = founder; this.owner = founder; }

  isMember(id) { return id === this.owner || this.members.has(id); }
  isMod(id) { return this.mods.has(id); }
  /** The owner or a moderator. */
  isStaff(id) { return id === this.owner || this.mods.has(id); }

  /** Everything we hold, applied ones in order, then those still missing a predecessor
   *  (so that a peer who has the missing part can complete the chain). */
  envs() { return [...this.chain, ...this.#waiting.values()]; }

  /** Envelopes held back because an earlier link of the chain is missing here. Only a peer that
   *  has that link (the owner, or a member who was given it) can complete the list. */
  get gap() { return this.#waiting.size; }

  /** The envelopes held back (see `gap`): a joiner's own admission may be one of them, and it
   *  must survive a restart, because nobody else may have it. */
  waitingEnvs() { return [...this.#waiting.values()]; }

  /** The start of the chain, as many envelopes as fit in `maxBytes`: what a joiner is given
   *  with their admission, so that they can hand the whole list on to the others. */
  prefix(maxBytes) {
    const out = [];
    let size = 0;
    for (const env of this.envs()) {
      size += JSON.stringify(env).length;
      if (size > maxBytes) break;
      out.push(env);
    }
    return out;
  }

  /** Apply one admin envelope. Returns the envelopes that took effect (this one and any
   *  that were waiting for it), or [] if it was refused or must wait for a predecessor. */
  apply(env) {
    this.retracted = [];
    if (this.#applied.has(env.id)) return [];
    const { prev } = env.body;
    if (prev !== this.head && !this.#displace(env)) {
      if (prev === '' || this.#applied.has(prev)) { // forks settled history
        this.forks++;
        return [];
      }
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

  /** A moderator's `admit` is the last link and `env` is another link made on the same `prev`
   *  that beats it (the owner's, or a moderator's with the smaller id): take that admit back, so
   *  that everyone ends up with the same list whichever of the two they saw first. Nothing else
   *  is ever taken back: a removal changes the room's keys. */
  #displace(env) {
    const last = this.chain.at(-1);
    if (!last || env.body.prev !== last.body.prev) return false;
    if (last.kind !== 'admit' || authorIdOf(last) === this.owner) return false;
    const byOwner = authorIdOf(env) === this.owner;
    if (!byOwner && !(env.kind === 'admit' && env.id < last.id)) return false;
    const rest = this.chain.slice(0, -1);
    this.#reset(rest);
    if (this.#valid(env)) { this.retracted = [last]; return true; }
    this.#reset([...rest, last]); // it would not hold either: leave things as they were
    return false;
  }

  #reset(chain) {
    this.owner = this.founder;
    [this.head, this.chain] = ['', []];
    [this.members, this.names] = [new Map(), new Map()];
    [this.revoked, this.mods] = [new Set(), new Set()];
    [this.recoveryKey, this.epoch] = [null, { n: 0, commit: null }];
    this.#applied.clear();
    for (const env of chain) this.#commit(env);
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
    const { body } = env;
    const next = (e) => e.n === this.epoch.n + 1; // rotations count up one by one
    if (env.kind === 'recover') { // signed by the recovery key, not by an identity we know
      return this.recoveryKey !== null && env.pub === this.recoveryKey && next(body.epoch);
    }
    const author = authorIdOf(env);
    if (author !== this.owner) { // a moderator may only let someone in: no roles, not the removed
      return env.kind === 'admit' && this.mods.has(author) && body.role === undefined
        && body.id !== this.owner && !this.revoked.has(body.id);
    }
    if (env.kind === 'revoke') return body.id !== this.owner && (!body.epoch || next(body.epoch));
    if (env.kind === 'transfer') return this.members.has(body.to);
    if (env.kind === 'admit' && body.role !== undefined) { // the owner sets a role
      return body.id !== this.owner && (body.role === 'mod' || this.mods.has(body.id));
    }
    return env.kind === 'admit' || env.kind === 'recovery';
  }

  #commit(env) {
    const { body } = env;
    if (env.kind === 'admit') {
      if (body.id !== this.owner) this.members.set(body.id, { name: body.name });
      this.names.set(body.id, body.name);
      this.revoked.delete(body.id);
      if (body.role === 'mod' && body.id !== this.owner) this.mods.add(body.id);
      if (body.role === 'member') this.mods.delete(body.id);
    } else if (env.kind === 'revoke') {
      this.members.delete(body.id);
      this.mods.delete(body.id);
      this.revoked.add(body.id);
      if (body.epoch) { this.epoch = body.epoch; this.recoveryKey = null; } // old codes are stale
    } else if (env.kind === 'recovery') {
      this.recoveryKey = body.key;
    } else if (env.kind === 'recover') { // the old owner is gone (lost, or compromised)
      this.members.delete(body.to);
      this.mods.delete(body.to);
      this.revoked.add(this.owner);
      this.revoked.delete(body.to);
      [this.owner, this.epoch, this.recoveryKey] = [body.to, body.epoch, null];
    } else { // transfer: the old owner stays a member, with no way back in
      this.members.delete(body.to);
      this.mods.delete(body.to);
      this.members.set(this.owner, { name: env.name });
      [this.owner, this.recoveryKey] = [body.to, null];
    }
    this.chain.push(env);
    this.head = env.id;
    this.#applied.add(env.id);
  }
}
