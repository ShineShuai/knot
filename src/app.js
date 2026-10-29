// UI-agnostic application model: owns the identity, settings and the set of rooms.
// Events: 'rooms' (list changed)
import { Emitter } from './util/emitter.js';
import { fromB64u, toB64u } from './util/bytes.js';
import { saveSettings } from './config.js';
import { newBoxKey } from './crypto/box.js';
import { makeLinkGrant, makeLinkRequest, readLinkGrant, readLinkRequest } from './chat/devices.js';
import { deriveRoomKeys, newRoomSecret } from './crypto/room-keys.js';
import { decodeRecoveryCode } from './chat/recovery.js';
import { verifyHandshake } from './net/handshake.js';
import { Room } from './chat/room.js';
import { MessageStore } from './chat/message-store.js';

/** "Room 1", "Room 2", ...: the first one not taken, so two rooms never get the same name. */
export function nextRoomName(labels, base) {
  const used = new Set(labels);
  for (let n = 1; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`;
}

export class AppModel extends Emitter {
  rooms = new Map(); // room id -> Room
  #removed = new Set(); // ids of rooms left in this tab (so saving does not bring them back)
  #saving = Promise.resolve();

  /** `WS`, `linkFactory`, `callEnv`: injectable network and media pieces (tests); the
   *  defaults are the browser's. */
  constructor({ kv, identity, settings, iceServers, WS, linkFactory, callEnv, brokerHealth }) {
    super();
    Object.assign(this, { kv, identity, settings, WS, linkFactory, callEnv, brokerHealth });
    this.iceServers = iceServers;
  }

  async load() {
    for (const saved of (await this.kv.get('rooms')) ?? []) await this.#open(
      fromB64u(saved.secret),
      saved.label,
      saved.owner ?? null,
    );
    if (this.rooms.size) await this.#persist(); // writes back what an older version dropped
    this.emit('rooms');
  }

  /** Create a brand-new room. We become its owner: nobody gets in without our approval. */
  async createRoom(label) {
    if (this.isLinked) throw new Error('Create rooms on your main device');
    return this.addRoom(newRoomSecret(), label, this.identity.id);
  }

  // ---- linked devices (see chat/devices.js) ------------------------------------------------

  /** Is this device linked to another one, writing as that device's identity? */
  get isLinked() { return !!this.identity.cert; }

  /** Main device: the devices linked so far, as { d: device key, n: name, ms }. */
  async linkedDevices() { return (await this.kv.get('linked')) ?? []; }

  /** Main device: answer a code from a new device. Resolves to { code, sas, name }: show the code
   *  (it holds our rooms, sealed to that device) and the six digits to compare. */
  async linkDevice(requestText) {
    if (this.isLinked) throw new Error('Only the main device can link a device');
    const request = await readLinkRequest(requestText);
    if (!request) throw new Error('That is not a valid device code (or it has expired)');
    const rooms = [...this.rooms.values()].map((room) => room.exportState());
    const grant = await makeLinkGrant(
      this.identity, request, { name: this.settings.name, rooms },
    );
    const others = (await this.linkedDevices()).filter((x) => x.d !== grant.cert.d);
    const added = { d: grant.cert.d, n: grant.cert.n, ms: grant.cert.ms };
    await this.kv.put('linked', [...others, added]);
    this.emit('devices');
    return { code: grant.code, sas: grant.sas, name: request.name };
  }

  /** Main device: withdraw a linked device in every room. */
  async unlinkDevice(devicePub) {
    for (const room of this.rooms.values()) await room.unlinkDevice(devicePub).catch(() => {});
    await this.kv.put('linked', (await this.linkedDevices()).filter((x) => x.d !== devicePub));
    this.emit('devices');
  }

  /** New device: make a code for the main device. `read(text)` then reads the code it answers
   *  with: null if invalid, else { name, mainId, sas, rooms, apply() }; `apply()` stores the
   *  link and the rooms (reload the app after it). */
  async startLinking(deviceName) {
    if (this.isLinked) throw new Error('This device is already linked');
    const boxKey = await newBoxKey();
    const name = deviceName || `device-${this.identity.id.slice(0, 4)}`;
    const code = await makeLinkRequest(this.identity, { name, boxPub: boxKey.pub });
    const read = async (text) => {
      const grant = await readLinkGrant(
        text, { identity: this.identity, boxKey, boxPub: boxKey.pub },
      );
      if (!grant) return null;
      return {
        name: grant.name, mainId: grant.mainId, sas: grant.sas, rooms: grant.rooms.length,
        apply: () => this.#applyGrant(grant),
      };
    };
    return { code, read };
  }

  async #applyGrant({ cert, name, rooms }) {
    await this.kv.put('delegate', { cert });
    if (name) {
      this.settings.name = name;
      await saveSettings(this.kv, this.settings);
    }
    for (const r of rooms) {
      await this.completeJoin(
        { secret: fromB64u(r.secret), label: r.label, founder: r.founder, epoch: r.epoch },
      );
    }
  }

  /** The main device withdrew this device: go back to being a device of our own. */
  async forgetLinking() { await this.kv.delete('delegate'); }

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
    await this.kv.delete(`owner:${id}`);
    await this.kv.delete(`read:${id}`);
    this.#removed.add(id);
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
      callEnv: this.callEnv,
      health: this.brokerHealth ?? null,
      iceServers: () => this.iceServers(),
    };
  }

  async #open(secret, label, owner = null) {
    // The owner is also kept under a key of its own: an older version of the app, perhaps in
    // another tab, rewrites the room list without it, and the room would silently turn into
    // an open one.
    const { id } = await deriveRoomKeys(secret);
    owner ??= (await this.kv.get(`owner:${id}`)) ?? null;
    if (owner) await this.kv.put(`owner:${id}`, owner);
    const room = await Room.open(this.#options(secret, label, owner));
    if (this.rooms.has(room.id)) return this.rooms.get(room.id);
    room.start();
    this.rooms.set(room.id, room);
    return room;
  }

  /** The name is only ours (each member names rooms on their own device). */
  async renameRoom(id, label) {
    const room = this.rooms.get(id);
    const next = String(label ?? '').trim().slice(0, 40);
    if (!room || !next) return;
    room.label = next;
    await this.#persist();
    this.emit('rooms');
  }

  /** One save at a time: two rooms created together must both end up in the list. */
  #persist() {
    const run = this.#saving.then(() => this.#writeRooms());
    this.#saving = run.catch(() => {});
    return run;
  }

  /** Save the room list, keeping rooms another tab added meanwhile. */
  async #writeRooms() {
    const mine = [...this.rooms.values()].map((r) => (
      { secret: toB64u(r.secret), label: r.label, owner: r.roster?.founder ?? null }
    ));
    const others = [];
    for (const entry of (await this.kv.get('rooms')) ?? []) {
      const { id } = await deriveRoomKeys(fromB64u(entry.secret));
      if (!this.rooms.has(id) && !this.#removed.has(id)) others.push(entry);
    }
    await this.kv.put('rooms', [...mine, ...others]);
  }
}
