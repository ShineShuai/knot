// UI-agnostic application model: owns the identity, settings and the set of rooms.
// Events: 'rooms' (list changed)
import { Emitter } from './util/emitter.js';
import { fromB64u, toB64u } from './util/bytes.js';
import { deriveRoomKeys, newRoomSecret } from './crypto/room-keys.js';
import { verifyHandshake } from './net/handshake.js';
import { Room } from './chat/room.js';
import { MessageStore } from './chat/message-store.js';

export class AppModel extends Emitter {
  rooms = new Map(); // room id -> Room

  constructor({ kv, identity, settings, iceServers }) {
    super();
    Object.assign(this, { kv, identity, settings });
    this.iceServers = iceServers;
  }

  async load() {
    for (const saved of (await this.kv.get('rooms')) ?? []) await this.#open(
      fromB64u(saved.secret),
      saved.label,
    );
    this.emit('rooms');
  }

  /** Create a brand-new room. */
  createRoom(label) { return this.addRoom(newRoomSecret(), label); }

  /** Join (or return the existing) room with this secret. */
  async addRoom(secret, label) {
    const room = await this.#open(secret, label);
    await this.#persist();
    this.emit('rooms');
    return room;
  }

  /** Manual pairing, invitee side: open the inviter's room and answer their offer. */
  async joinOffer(offer) {
    await verifyHandshake(offer);
    const existed = this.rooms.has((await deriveRoomKeys(offer.roomSecret)).id);
    const room = await this.addRoom(offer.roomSecret, `${offer.name}`);
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
    this.rooms.delete(id);
    await this.#persist();
    this.emit('rooms');
  }

  #options(secret, label) {
    return {
      identity: this.identity,
      secret,
      label,
      kv: this.kv,
      settings: this.settings,
      iceServers: () => this.iceServers(),
    };
  }

  async #open(secret, label) {
    const room = await Room.open(this.#options(secret, label));
    if (this.rooms.has(room.id)) return this.rooms.get(room.id);
    room.start();
    this.rooms.set(room.id, room);
    return room;
  }

  #persist() {
    return this.kv.put(
      'rooms',
      [...this.rooms.values()].map((r) => ({ secret: toB64u(r.secret), label: r.label })),
    );
  }
}
