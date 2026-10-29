// What the room owner does: answer join requests (listening in the lobby, a broker channel only
// the owner reads), remove members, hand the room over, and the recovery code that takes a
// room back after the owner's identity is lost. A room without an owner never uses this.
import { identityFromSeed } from '../crypto/identity.js';
import { RoomChannel } from '../net/room-channel.js';
import { randomBytes, sha256, toB64u } from '../util/bytes.js';
import { admitBody, recoverBody, recoveryBody, revokeBody, transferBody } from './envelope.js';
import { lobbyKeys, lobbySecretOf, makeDeny, makeGrant, readRequest } from './lobby.js';
import { encodeRecoveryCode } from './recovery.js';

const MAX_JOIN_REQUESTS = 50;

export class OwnerDesk {
  #joinRequests = new Map(); // joiner id -> request waiting for the owner's decision
  #lobby = null; #lobbyId = null;
  #recoverWith = null; #recovering = false; // a recovery code in use on this device

  /** `hooks`: publish(kind, body, signer), epoch() -> { n, secret }, applyEpoch(n, secret),
   *  shareEpoch(exceptId), chanSecret(): the parts of the room that stay private to it. */
  constructor(room, hooks) {
    this.room = room;
    this.hooks = hooks;
  }

  #requireOwner() { if (!this.room.isOwner) throw new Error('Only the room owner can do this'); }

  get requests() {
    return [...this.#joinRequests.values()].map(({ id, name, greeting, ts }) => (
      { id, name, greeting, ts }
    ));
  }

  /** Owner only: let a requester in. They get the room secret, sealed to them alone. */
  async approveJoin(id) {
    this.#requireOwner();
    const req = this.#joinRequests.get(id);
    if (!req) throw new Error('This request is no longer open');
    await this.admit(req.id, req.name);
    await this.#grant(req);
    this.#joinRequests.delete(id);
    this.room.emit('requests');
  }

  async declineJoin(id) {
    this.#requireOwner();
    const req = this.#joinRequests.get(id);
    if (!req) return;
    this.#joinRequests.delete(id);
    this.room.emit('requests');
    await this.#lobby?.sendSignal(
      req.id, await makeDeny(this.room.identity, { lobbyId: this.#lobbyId, to: req.id }),
    );
  }

  /** Owner only: remove a member. Honest peers drop their links and ignore them from now on,
   *  and the room moves to new channel keys that the removed member never gets. Old recovery
   *  codes stop working: make a new one (see newRecoveryCode). */
  async removeMember(id) {
    this.#requireOwner();
    if (id === this.room.identity.id) throw new Error('Transfer the room first, then leave it');
    if (!this.room.roster.isMember(id)) throw new Error('Not a member of this room');
    const [n, secret] = [this.hooks.epoch().n + 1, randomBytes(16)];
    const commit = toB64u(await sha256(secret));
    const env = await this.hooks.publish(
      'revoke', revokeBody({ id, epoch: { n, commit } }, this.room.roster.head),
    );
    await this.hooks.applyEpoch(n, secret);
    this.hooks.shareEpoch(id);
    return env;
  }

  /** Owner only: a new recovery code (and the old one stops working). Show it once, to keep
   *  offline; it is not stored here. */
  async newRecoveryCode() {
    this.#requireOwner();
    const seed = randomBytes(32);
    const key = await identityFromSeed(seed);
    const { roster } = this.room;
    await this.hooks.publish('recovery', recoveryBody({ key: toB64u(key.pub) }, roster.head));
    const epoch = this.hooks.epoch().n ? this.hooks.epoch() : null;
    return encodeRecoveryCode({
      secret: this.room.secret, founder: this.room.roster.founder, seed, epoch,
    });
  }

  /** On a new device with a recovery code: as soon as a member shows us the chain (and it
   *  holds this code's key), claim the room. Needs one member online. */
  async beginRecovery(seed) {
    this.#recoverWith = await identityFromSeed(seed);
    await this.tryRecover();
  }

  get recovering() { return !!this.#recoverWith && !this.room.isOwner; }

  async tryRecover() {
    const key = this.#recoverWith;
    if (!key || this.#recovering || this.room.isOwner || this.room.removed) return;
    // chain not seen yet, or code stale
    if (this.room.roster.recoveryKey !== toB64u(key.pub)) return;
    this.#recovering = true;
    try {
      const [n, secret] = [this.hooks.epoch().n + 1, randomBytes(16)];
      const commit = toB64u(await sha256(secret));
      const env = await this.hooks.publish('recover', recoverBody(
        { to: this.room.identity.id, epoch: { n, commit } }, this.room.roster.head,
      ), key);
      // Members still treat us as a stranger: only admin frames get through until they apply it.
      const frame = JSON.stringify({ t: 'admin', es: [env] });
      for (const p of this.room.peers.values()) if (p.state === 'p2p') p.link.sendChat(frame);
      await this.hooks.applyEpoch(n, secret);
      this.hooks.shareEpoch(null);
      this.#recoverWith = null;
      this.room.emit('recovered');
    } finally { this.#recovering = false; }
  }

  /** Owner only: hand the room to another member. Old join links stop working. */
  async transferOwnership(id) {
    this.#requireOwner();
    if (!this.room.roster.members.has(id)) throw new Error('Pick a current member');
    return this.hooks.publish('transfer', transferBody({ to: id }, this.room.roster.head));
  }

  admit(id, name) {
    if (this.room.roster.isMember(id)) return null;
    return this.hooks.publish('admit', admitBody({ id, name }, this.room.roster.head));
  }

  async #grant(req) {
    const { roster, secret, label } = this.room;
    const admit = roster.chain.findLast((e) => e.kind === 'admit' && e.body.id === req.id);
    const { n, secret: epochSecret } = this.hooks.epoch();
    const epoch = n ? { n, s: toB64u(epochSecret) } : null;
    const payload = {
      secret, label, admit, founder: roster.founder, epoch,
    };
    await this.#lobby?.sendSignal(req.id, await makeGrant(
      this.room.identity, { lobbyId: this.#lobbyId, to: req.id, boxPub: req.boxPub, payload },
    ));
  }

  /** The owner listens in the lobby; nobody else does. Follows ownership changes. */
  async sync() {
    const { settings } = this.room;
    const want = this.room.isOwner && !this.room.removed && settings.brokersEnabled
      && settings.brokers.length > 0;
    if (!want) {
      this.#lobby?.stop();
      this.#lobby = null;
      this.#joinRequests.clear();
      return;
    }
    if (this.#lobby) return;
    const { identity } = this.room;
    const keys = await lobbyKeys(await lobbySecretOf(this.hooks.chanSecret()), identity.id);
    this.#lobbyId = keys.id;
    this.#lobby = new RoomChannel({
      roomId: keys.id, aes: keys.aes, selfId: this.room.identity.id, WS: this.room.WS,
      brokers: settings.brokers, topicPrefix: settings.topicPrefix, health: this.room.health,
    });
    this.#lobby.on('signal', (bytes) => this.#onJoinRequest(bytes));
    this.#lobby.start();
  }

  async #onJoinRequest(bytes) {
    const req = await readRequest(bytes, this.#lobbyId);
    if (!req || !this.room.isOwner || req.id === this.room.identity.id) return;
    if (this.room.roster.revoked.has(req.id)) return;
    if (this.room.roster.isMember(req.id)) { // knocked twice
      return void this.#grant(req).catch(() => {});
    }
    const isNew = !this.#joinRequests.has(req.id);
    if (isNew && this.#joinRequests.size >= MAX_JOIN_REQUESTS) return;
    this.#joinRequests.set(req.id, req);
    if (isNew) this.room.emit('requests');
  }

  /** An admin change dropped this requester's open request (they were removed). */
  dropRequest(id) { this.#joinRequests.delete(id); }

  /** The channel keys rotated: the lobby moves with them (old join links stop working). */
  async restart() {
    if (!this.#lobby) return;
    this.#lobby.stop();
    this.#lobby = null;
    this.#joinRequests.clear();
    await this.sync();
  }

  stop() { this.#lobby?.stop(); }
}
