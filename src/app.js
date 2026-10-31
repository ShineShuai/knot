// UI-agnostic application model: owns the identity, settings and the set of rooms.
// Events: 'rooms' (list changed), 'devices' (linked devices or aliases changed), 'settings'
// (keys: another device of ours changed them).
import { Emitter } from './util/emitter.js';
import { fromB64u, toB64u } from './util/bytes.js';
import { saveSettings } from './config.js';
import { newBoxKey } from './crypto/box.js';
import { makeLinkGrant, makeLinkRequest, readLinkGrant, readLinkRequest } from './chat/devices.js';
import {
  DeviceSync, SHARED, deviceKey, suggestAlias, uniqueAlias,
} from './chat/device-sync.js';
import { ALIAS_MAX, isAlias } from './chat/envelope.js';
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
    this.sync = new DeviceSync({ kv, settings, deviceId: identity.id });
    this.sync.on('change', (keys, local) => {
      if (local) return;
      this.#applyOwnAlias();
      this.emit('settings', keys);
      if (keys.some((k) => k.startsWith('d:'))) this.emit('devices');
    });
  }

  async load() {
    await this.sync.load();
    await this.#sharePrevious();
    this.#applyOwnAlias();
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

  // ---- settings and aliases shared by all our devices (see chat/device-sync.js) --------------

  /** Change settings. Shared ones reach our other devices (the newest change wins everywhere);
   *  the others (the browser's notification permission) stay on this device. */
  async updateSettings(patch) {
    const shared = Object.fromEntries(Object.entries(patch).filter(([k]) => SHARED.includes(k)));
    const changed = await this.sync.set(shared);
    const local = Object.fromEntries(Object.entries(patch).filter(([k]) => !SHARED.includes(k)));
    if (Object.keys(local).length) {
      Object.assign(this.settings, local);
      await saveSettings(this.kv, this.settings);
    }
    this.#broadcastSync(changed);
  }

  /** Our public key, and the main device's: the keys of the device list. */
  get #ownPub() { return toB64u(this.identity.pub); }

  get #rootPub() { return this.identity.cert?.r ?? this.#ownPub; }

  /** Every device of this identity: { pub, alias, main, self }; alias '' = the main device's
   *  default. */
  deviceRows() {
    const aliases = this.sync.aliases;
    const [root, own] = [this.#rootPub, this.#ownPub];
    const rows = [{ pub: root, alias: aliases.get(root) ?? '', main: true, self: root === own }];
    for (const pub of new Set([...aliases.keys(), own])) {
      if (pub === root) continue;
      rows.push({
        pub, alias: aliases.get(pub) ?? this.identity.cert?.n ?? '', main: false, self: pub === own,
      });
    }
    return rows;
  }

  /** Give a device an alias of the person's choice (any of our devices may rename any). A taken
   *  alias gets a number. Resolves to the alias in effect. */
  async setDeviceAlias(pub, text) {
    const wanted = String(text ?? '').trim();
    const rows = this.deviceRows();
    const row = rows.find((r) => r.pub === pub);
    if (!row || !isAlias(wanted) || (!wanted && !row.main)) throw new Error('Not a valid alias');
    const taken = rows.filter((r) => r.pub !== pub).map((r) => r.alias || 'main');
    const alias = wanted && uniqueAlias(wanted, taken);
    this.#broadcastSync(await this.sync.set({ [deviceKey(pub)]: alias }));
    this.#applyOwnAlias();
    this.emit('devices');
    return alias;
  }

  /** What other people see after our name: set only if it differs from the default (the
   *  certificate's name, or none for the main device). */
  #applyOwnAlias() {
    const item = this.sync.alias(this.#ownPub);
    const next = item && item !== (this.identity.cert?.n ?? '') ? item : undefined;
    if (next === this.identity.alias) return;
    this.identity.alias = next;
    for (const room of this.rooms.values()) room.announceAlias();
  }

  /** Main device that linked devices before they shared anything: share what is there. */
  async #sharePrevious() {
    if (this.isLinked) return;
    const linked = await this.linkedDevices();
    if (!linked.length) return;
    await this.sync.seed();
    for (const d of linked) {
      if (this.sync.alias(d.d) === undefined) await this.sync.set({ [deviceKey(d.d)]: d.n });
    }
  }

  #broadcastSync(items) {
    if (!Object.keys(items).length) return;
    for (const room of this.rooms.values()) room.sendToSiblings({ t: 'sync', items });
  }

  async #receiveSync(items) {
    const accepted = await this.sync.merge(items);
    if (Object.keys(accepted).length) this.#broadcastSync(accepted);
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
    // The new device's alias: what it asked for, numbered if another device has it already.
    const taken = this.deviceRows().map((r) => r.alias || 'main');
    const want = request.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, ALIAS_MAX);
    const alias = uniqueAlias(want || 'device', taken);
    await this.sync.seed();
    await this.sync.set({ [deviceKey(toB64u(request.pub))]: alias });
    const grant = await makeLinkGrant(
      this.identity, { ...request, name: alias },
      { name: this.settings.name, rooms, sync: this.sync.items },
    );
    const others = (await this.linkedDevices()).filter((x) => x.d !== grant.cert.d);
    const added = { d: grant.cert.d, n: grant.cert.n, ms: grant.cert.ms };
    await this.kv.put('linked', [...others, added]);
    this.emit('devices');
    return { code: grant.code, sas: grant.sas, name: alias };
  }

  /** Main device: withdraw a linked device in every room. */
  async unlinkDevice(devicePub) {
    for (const room of this.rooms.values()) await room.unlinkDevice(devicePub).catch(() => {});
    await this.kv.put('linked', (await this.linkedDevices()).filter((x) => x.d !== devicePub));
    this.#broadcastSync(await this.sync.set({ [deviceKey(devicePub)]: null }));
    this.emit('devices');
  }

  /** New device: make a code for the main device. `read(text)` then reads the code it answers
   *  with: null if invalid, else { name, mainId, sas, rooms, apply() }; `apply()` stores the
   *  link and the rooms (reload the app after it). */
  async startLinking(deviceName) {
    if (this.isLinked) throw new Error('This device is already linked');
    const boxKey = await newBoxKey();
    const name = deviceName || suggestAlias() || `device-${this.identity.id.slice(0, 4)}`;
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

  async #applyGrant({ cert, name, rooms, sync }) {
    await this.kv.put('delegate', { cert });
    if (sync) await this.sync.merge(sync);
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
  async forgetLinking() {
    await this.kv.delete('delegate');
    await this.kv.delete('sync');
  }

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
    room.on('sibling', (entry) => room.sendToSibling(entry, { t: 'sync', items: this.sync.items }));
    room.on('sync', (items) => this.#receiveSync(items));
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
