// UI-agnostic application model: owns the identity, settings and the set of rooms.
// Events: 'rooms' (list changed)
import { Emitter } from './util/emitter.js';
import { fromB64u, toB64u } from './util/bytes.js';
import { deriveRoomKeys, newRoomSecret } from './crypto/room-keys.js';
import { decodeRecoveryCode } from './chat/recovery.js';
import { verifyHandshake } from './net/handshake.js';
import { Room } from './chat/room.js';
import { MessageStore } from './chat/message-store.js';

export class AppModel extends Emitter {
  rooms = new Map(); // room id -> Room

  /** `WS`, `linkFactory`: injectable network pieces (tests); the defaults are the browser's. */
  constructor({ kv, identity, settings, iceServers, WS, linkFactory }) {
    super();
    Object.assign(this, { kv, identity, settings, WS, linkFactory });
    this.iceServers = iceServers;
  }

  async load() {
    for (const saved of (await this.kv.get('rooms')) ?? []) await this.#open(
      fromB64u(saved.secret),
      saved.label,
      saved.owner ?? null,
    );
    this.emit('rooms');
  }

  /** Create a brand-new room. We become its owner: nobody gets in without our approval. */
  createRoom(label) { return this.addRoom(newRoomSecret(), label, this.identity.id); }

  /** Join (or return the existing) room with this secret. `owner`: its owner's id, if it has
   *  one (older rooms do not: anyone with the secret may join those). */
  async addRoom(secret, label, owner = null) {
    const room = await this.#open(secret, label, owner);
    await this.#persist();
    this.emit('rooms');
    return room;
  }

  /** Manual pairing, invitee side: open the inviter's room and answer their offer. */
  async joinOffer(offer) {
    await verifyHandshake(offer);
    const existed = this.rooms.has((await deriveRoomKeys(offer.roomSecret)).id);
    const room = await this.addRoom(offer.roomSecret, `${offer.name}`, offer.founder);
    try {
      return { room, reply: await room.answerOffer(offer) };
    } catch (err) {
      if (!existed) await this.removeRoom(room.id);
      throw err;
    }
  }

  async removeRoom(id) {
    const room = this.rooms.get(id);
    if (!room) return;
    room.stop();
    await new MessageStore(this.kv, id).clear();
    await room.previews.clear();
    await this.kv.delete(`epoch:${id}`);
    this.rooms.delete(id);
    await this.#persist();
    this.emit('rooms');
  }

  /** The owner said yes: open the room, with the approval that came with the grant. */
  async completeJoin({ secret, label, admit, founder, epoch }) {
    if (epoch) await this.kv.put(`epoch:${(await deriveRoomKeys(secret)).id}`, epoch);
    const room = await this.addRoom(secret, label, founder);
    if (admit) await room.receiveAdmin(admit);
    return room;
  }

  /** Take a room back with the owner's recovery code, on a device that lost everything. The
   *  room only changes hands once a member is online to see it (see Room.beginRecovery). */
  async recoverRoom(text, label) {
    const code = decodeRecoveryCode(text);
    if (code.epoch) {
      const { n, secret } = code.epoch;
      const { id } = await deriveRoomKeys(code.secret);
      await this.kv.put(`epoch:${id}`, { n, s: toB64u(secret) });
    }
    const room = await this.addRoom(code.secret, label, code.founder);
    await room.beginRecovery(code.seed);
    return room;
  }

  #options(secret, label, owner = null) {
    return {
      identity: this.identity,
      secret,
      label,
      owner,
      kv: this.kv,
      settings: this.settings,
      WS: this.WS,
      linkFactory: this.linkFactory,
      iceServers: () => this.iceServers(),
    };
  }

  async #open(secret, label, owner = null) {
    const room = await Room.open(this.#options(secret, label, owner));
    if (this.rooms.has(room.id)) return this.rooms.get(room.id);
    room.start();
    this.rooms.set(room.id, room);
    return room;
  }

  #persist() {
    return this.kv.put(
      'rooms',
      [...this.rooms.values()].map((r) => (
        { secret: toB64u(r.secret), label: r.label, owner: r.roster?.founder ?? null }
      )),
    );
  }
}
