// UI-agnostic application model: owns the identity, settings and the set of rooms.
// Events: 'rooms' (list changed), 'devices' (linked devices or aliases changed), 'settings'
// (keys: another device of ours changed them).
import { Emitter } from './util/emitter.js';
import { fromB64u, toB64u } from './util/bytes.js';
import { saveSettings } from './config.js';
import { newBoxKey } from './crypto/box.js';
import { makeLinkGrant, makeLinkRequest, readLinkGrant, readLinkRequest } from './chat/devices.js';
import {
  CHANNEL, DeviceSync, SHARED, deviceKey, readKey, roomKey, suggestAlias, uniqueAlias,
} from './chat/device-sync.js';
import { ALIAS_MAX, isAlias } from './chat/envelope.js';
import { deriveRoomKeys, newRoomSecret } from './crypto/room-keys.js';
import { decodeRecoveryCode } from './chat/recovery.js';
import { verifyHandshake } from './net/handshake.js';
import { Room } from './chat/room.js';
import { MemoryKV } from './store/kv.js';
import { MessageStore } from './chat/message-store.js';

/** "Room 1", "Room 2", ...: the first one not taken, so two rooms never get the same name. */
export function nextRoomName(labels, base) {
  const used = new Set(labels);
  for (let n = 1; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`;
}

const B64U = /^[A-Za-z0-9_-]+$/;

/** Key epochs received from another device: only well-formed ones, for known-length room ids. */
function cleanEpochs(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, e] of Object.entries(raw).slice(0, 200)) {
    if (id.length === 16 && B64U.test(id) && e && Number.isSafeInteger(e.n) && e.n >= 1
      && e.n <= 1e6 && typeof e.s === 'string' && e.s.length === 22 && B64U.test(e.s)) {
      out[id] = { n: e.n, s: e.s };
    }
  }
  return out;
}

export class AppModel extends Emitter {
  rooms = new Map(); // room id -> Room
  #removed = new Set(); // ids of rooms left in this tab (so saving does not bring them back)
  #saving = Promise.resolve();
  #paired = false; // do we have other devices to keep in step? (linked, or linked to)
  #deviceRoom = null; // where our devices meet when they share no room (see #syncChannel)
  #deviceSecret = '';

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
    await this.#refreshPaired();
    await this.#sharePrevious();
    this.#applyOwnAlias();
    for (const saved of (await this.kv.get('rooms')) ?? []) await this.#open(
      fromB64u(saved.secret),
      saved.label,
      saved.owner ?? null,
    );
    // what our other devices changed while this one was closed, then what only this one has
    await this.#applyRoomItems(this.sync.items, {});
    await this.#shareRooms();
    await this.#syncChannel();
    if (this.rooms.size) await this.#persist(); // writes back what an older version dropped
    this.emit('rooms');
  }

  /** Create a brand-new room. We become its owner: nobody gets in without our approval. */
  async createRoom(label) {
    return this.addRoom(newRoomSecret(), label, this.identity.member);
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
    for (const room of this.#allRooms()) room.announceAlias();
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

  /** Do we have other devices to keep in step? Alone, nothing about rooms is recorded. */
  get paired() { return this.#paired; }

  async #refreshPaired() {
    this.#paired = this.isLinked || (await this.linkedDevices()).length > 0;
  }

  /** What the others need to add a room: its secret, label and owner. */
  #roomValue(room) {
    return {
      s: toB64u(room.secret), l: String(room.label || 'Room').slice(0, 40),
      o: room.roster?.founder ?? null,
    };
  }

  /** Record (and send on) that a room was added, renamed or left (`room` null: left). */
  async #shareRoom(id, room) {
    if (!this.#paired) return;
    const value = room ? this.#roomValue(room) : null;
    this.#broadcastSync(await this.sync.set({ [roomKey(id)]: value }));
  }

  /** Record every room and how far we read it (what has no record yet, or is newer). */
  async #shareRooms() {
    if (!this.#paired) return;
    const patch = {};
    for (const room of this.rooms.values()) {
      patch[roomKey(room.id)] = this.#roomValue(room);
      const { ms, c } = room.readStamp;
      if (ms || c) patch[readKey(room.id)] = { ms, c };
    }
    this.#broadcastSync(await this.sync.set(patch));
  }

  /** Apply room and read-mark items that came from another device (or were stored): open the
   *  rooms it added, drop the rooms it left, take its labels and read marks. A room this
   *  identity owns is never dropped from afar: losing it cannot be undone. */
  async #applyRoomItems(items, epochs) {
    let changed = false;
    for (const [key, item] of Object.entries(items)) {
      if (key.startsWith('k:')) {
        await this.rooms.get(key.slice(2))?.advanceRead(item.v);
        continue;
      }
      if (!key.startsWith('r:')) continue;
      const [id, room, value] = [key.slice(2), this.rooms.get(key.slice(2)), item.v];
      if (value === null) {
        if (room && !room.isOwner) { await this.#dropRoom(id); changed = true; }
      } else if (!room) {
        if ((await deriveRoomKeys(fromB64u(value.s))).id !== id) continue; // not that room's secret
        if (epochs[id]) await this.kv.put(`epoch:${id}`, epochs[id]);
        this.#removed.delete(id);
        await this.#open(fromB64u(value.s), value.l, value.o);
        changed = true;
      } else if (room.label !== value.l) {
        room.label = value.l;
        changed = true;
      }
    }
    if (changed) { await this.#persist(); this.emit('rooms'); }
  }

  /** The key epoch of each room in `items` that we hold (a new device needs it to join). */
  #epochsFor(items) {
    const out = {};
    for (const [key, item] of Object.entries(items)) {
      if (!key.startsWith('r:') || !item.v) continue;
      const epoch = this.rooms.get(key.slice(2))?.exportState().epoch;
      if (epoch) out[key.slice(2)] = epoch;
    }
    return out;
  }

  #frame(items) { return { t: 'sync', items, epochs: this.#epochsFor(items) }; }

  #broadcastSync(items) {
    if (!Object.keys(items).length) return;
    const frame = this.#frame(items);
    for (const room of this.#allRooms()) room.sendToSiblings(frame);
  }

  /** The chat rooms, and the channel where our devices meet. */
  #allRooms() {
    return this.#deviceRoom ? [...this.rooms.values(), this.#deviceRoom] : [...this.rooms.values()];
  }

  /** Exchange state with a device of ours that connects in this room. */
  #wire(room) {
    room.on('sibling', (entry) => this.#sendSnapshot(room, entry));
    room.on('sync', (items, entry, epochs) => {
      this.#receiveSync(items, epochs).catch((err) => console.error('sync failed', err));
    });
  }

  /** Our devices find each other in a room that only they know (it is not in the room list and
   *  keeps nothing), so they stay in step even when they share no chat room, and a new device
   *  gets everything from the main device. The main device makes the secret; it travels in
   *  the shared state. */
  async #syncChannel() {
    let secret = this.#paired ? this.sync.value(CHANNEL) : null;
    if (this.#paired && !secret && !this.isLinked) {
      secret = toB64u(newRoomSecret());
      this.#broadcastSync(await this.sync.set({ [CHANNEL]: secret }));
    }
    if (!secret) secret = '';
    if (secret === this.#deviceSecret) return;
    this.#deviceRoom?.stop();
    [this.#deviceRoom, this.#deviceSecret] = [null, secret];
    if (!secret) return;
    const room = await Room.open(this.#options(fromB64u(secret), 'devices', null, new MemoryKV()));
    if (secret !== this.#deviceSecret) return room.stop(); // changed again meanwhile
    this.#wire(room);
    room.start();
    this.#deviceRoom = room;
  }

  /** Stop everything (the page is going away; tests). */
  stop() {
    for (const room of this.#allRooms()) room.stop();
  }

  /** Everything we hold, to a device of ours that just connected (in small frames). */
  #sendSnapshot(room, entry) {
    const all = Object.entries(this.sync.items);
    for (let i = 0; i < all.length; i += 40) {
      room.sendToSibling(entry, this.#frame(Object.fromEntries(all.slice(i, i + 40))));
    }
  }

  /** Another device of ours withdrew a device: refuse it everywhere here, and forget its name. */
  async #forgetDevice(pub) {
    for (const room of this.#allRooms()) room.dropDevice(pub);
    await this.kv.put('linked', (await this.linkedDevices()).filter((x) => x.d !== pub));
    await this.#refreshPaired();
    this.emit('devices');
  }

  async #receiveSync(items, epochs) {
    const accepted = await this.sync.merge(items);
    if (!Object.keys(accepted).length) return;
    await this.#applyRoomItems(accepted, cleanEpochs(epochs));
    for (const [key, item] of Object.entries(accepted)) { // a device of ours was unlinked
      if (key.startsWith('d:') && item.v === null) await this.#forgetDevice(key.slice(2));
    }
    if (CHANNEL in accepted) await this.#syncChannel();
    this.#broadcastSync(accepted);
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
    // Same browser profile (another tab of this app): that "device" is this one. Linking it
    // would make this device a linked device of itself, which nothing can undo.
    if (request.id === this.identity.id) throw new Error('That code was made by this device');
    const rooms = [...this.rooms.values()].map((room) => room.exportState());
    // The new device's alias: what it asked for, numbered if another device has it already.
    const taken = this.deviceRows().map((r) => r.alias || 'main');
    const want = request.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, ALIAS_MAX);
    const alias = uniqueAlias(want || 'device', taken);
    await this.sync.seed();
    await this.sync.set({ [deviceKey(toB64u(request.pub))]: alias });
    this.#paired = true;
    await this.#shareRooms();
    await this.#syncChannel();
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
    const row = this.deviceRows().find((r) => r.pub === devicePub);
    if (!row || row.main || row.self) throw new Error('That device cannot be unlinked here');
    this.#deviceRoom?.dropDevice(devicePub); // first: it must not hear what follows
    for (const room of this.rooms.values()) await room.unlinkDevice(devicePub).catch(() => {});
    this.#broadcastSync(await this.sync.set({ [deviceKey(devicePub)]: null }));
    await this.#forgetDevice(devicePub);
    await this.#syncChannel();
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
      if (!grant || grant.mainId === this.identity.id) return null; // never to ourselves
      return {
        name: grant.name, mainId: grant.mainId, sas: grant.sas, rooms: grant.rooms.length,
        apply: () => this.#applyGrant(grant),
      };
    };
    return { code, read };
  }

  async #applyGrant({ cert, name, rooms, sync }) {
    await this.kv.put('delegate', { cert });
    if (sync) await this.sync.adopt(sync); // the main device's settings, not ours
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
    this.#paired = false;
    await this.#syncChannel();
  }

  /** Join (or return the existing) room with this secret. `owner`: its owner's id, if it has
   *  one (older rooms do not: anyone with the secret may join those). */
  async addRoom(secret, label, owner = null) {
    const room = await this.#open(secret, label, owner);
    await this.#persist();
    await this.#shareRoom(room.id, room);
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
    if (!this.rooms.has(id)) return;
    if (this.#paired) { // tell our other devices while the links are still up, and let it out
      await this.#shareRoom(id, null);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    await this.#dropRoom(id);
    this.emit('rooms');
  }

  /** Forget a room on this device (what removeRoom does, and what a device of ours leaving it
   *  does here). */
  async #dropRoom(id) {
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

  #options(secret, label, owner = null, kv = this.kv) {
    return {
      identity: this.identity,
      secret,
      label,
      owner,
      kv,
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
    const synced = this.sync.value(readKey(room.id));
    if (synced) await room.advanceRead(synced); // read on another device of ours already
    this.#wire(room);
    room.on('read', (stamp) => {
      if (!this.#paired) return;
      this.sync.set({ [readKey(room.id)]: stamp }).then((items) => this.#broadcastSync(items))
        .catch((err) => console.error('sync failed', err));
    });
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
    await this.#shareRoom(id, room);
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
