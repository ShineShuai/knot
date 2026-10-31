// What all devices of one identity share: the settings, the devices' aliases, the list of rooms
// and how far each room has been read. Each value is a last-writer-wins register with a stamp
// (hybrid clock, device id as tie-break), so a change on any device reaches the others in any
// order and the newest one wins everywhere; the exception is a read mark, which only ever
// moves forward. Devices exchange these over their direct links (see Room 'sibling' / 'sync');
// nothing else sees them.
//
//   <setting name>   a shared setting (SHARED)
//   d:<device key>   the device's alias; null once it was unlinked
//   r:<room id>      { s: room secret, l: label, o: owner id | null }; null once it was left
//   k:<room id>      { ms, c }: the newest message stamp read on any of our devices
//   c:devices        the secret of the channel where our devices meet when they share no room
import { saveSettings } from '../config.js';
import { HLC, compareStamps } from '../util/hlc.js';
import { ALIAS_MAX, isAlias } from './envelope.js';
import { Emitter } from '../util/emitter.js';

/** Settings that follow the person; the rest (e.g. the browser's notification permission)
 *  belongs to one device. */
export const SHARED = Object.freeze([
  'name', 'language', 'stunServers', 'turnServers', 'brokers', 'brokersEnabled', 'relayFallback',
  'imagePreviews',
]);
/** Key of a device's alias: "d:" and the device's public key (base64url). null = unlinked. */
export const deviceKey = (pub) => `d:${pub}`;
export const roomKey = (id) => `r:${id}`;
export const readKey = (id) => `k:${id}`;
export const CHANNEL = 'c:devices';
const DEVICE = /^d:[A-Za-z0-9_-]{43}$/;
const ROOM = /^r:[A-Za-z0-9_-]{16}$/;
const READ = /^k:[A-Za-z0-9_-]{16}$/;
const MAX_ITEMS = 1000;

const isList = (v, max, ok) => Array.isArray(v) && v.length <= max && v.every(ok);
const url = (prefix) => (s) => typeof s === 'string' && s.length <= 200 && prefix.test(s);
const CHECKS = {
  name: (v) => typeof v === 'string' && v.length <= 32,
  language: (v) => typeof v === 'string' && /^[A-Za-z-]{2,8}$/.test(v),
  stunServers: (v) => isList(v, 10, url(/^stuns?:/)),
  turnServers: (v) => isList(v, 10, (x) => !!x && typeof x === 'object' && !Array.isArray(x))
    && JSON.stringify(v).length <= 2000,
  brokers: (v) => isList(v, 10, url(/^wss:\/\//)),
  brokersEnabled: (v) => typeof v === 'boolean',
  relayFallback: (v) => typeof v === 'boolean',
  imagePreviews: (v) => ['auto', 'tap', 'off'].includes(v),
};
const B64U = /^[A-Za-z0-9_-]+$/;
const validRoom = (v) => v === null || (!!v && typeof v === 'object'
  && Object.keys(v).every((k) => ['s', 'l', 'o'].includes(k))
  && typeof v.s === 'string' && v.s.length === 22 && B64U.test(v.s)
  && typeof v.l === 'string' && v.l.length >= 1 && v.l.length <= 40
  && (v.o === null || (typeof v.o === 'string' && v.o.length === 11 && B64U.test(v.o))));
const validStamp = (v) => !!v && typeof v === 'object' && Object.keys(v).length === 2
  && Number.isSafeInteger(v.ms) && v.ms >= 0 && Number.isSafeInteger(v.c) && v.c >= 0;
const validValue = (key, v) => {
  if (key === CHANNEL) return typeof v === 'string' && v.length === 22 && B64U.test(v);
  if (DEVICE.test(key)) return v === null || isAlias(v);
  if (ROOM.test(key)) return validRoom(v);
  if (READ.test(key)) return validStamp(v);
  return !!CHECKS[key]?.(v);
};
const known = (key) => SHARED.includes(key) || DEVICE.test(key) || ROOM.test(key)
  || READ.test(key) || key === CHANNEL;
const validItem = (key, i) => !!i && typeof i === 'object' && validValue(key, i.v)
  && Number.isSafeInteger(i.ms) && i.ms >= 0 && Number.isSafeInteger(i.c) && i.c >= 0
  && typeof i.by === 'string' && i.by.length <= 16;

const newer = (a, b) => compareStamps(a, b) || (a.by < b.by ? -1 : a.by > b.by ? 1 : 0);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Keep only well-formed items for known keys (anything received is untrusted input). */
function clean(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const key of Object.keys(raw).slice(0, MAX_ITEMS)) {
    const i = raw[key];
    if (known(key) && validItem(key, i)) out[key] = { v: i.v, ms: i.ms, c: i.c, by: i.by };
  }
  return out;
}

/** A short alias from the kind of device ("iPhone", "Mac", ...); null if it cannot be told. */
export function suggestAlias(nav = globalThis.navigator) {
  const ua = nav?.userAgent ?? '';
  if (/iPhone|iPod/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && nav?.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux|X11/.test(ua)) return 'Linux';
  return null;
}

/** `want`, or "want 2", "want 3", ... : the first not in `taken` (compared ignoring case). */
export function uniqueAlias(want, taken) {
  const used = new Set([...taken].map((s) => s.toLowerCase()));
  const base = want.slice(0, ALIAS_MAX - 2);
  let name = want.slice(0, ALIAS_MAX);
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} ${n}`;
  return name;
}

/** Events: 'change' (keys, local). */
export class DeviceSync extends Emitter {
  #items = {};
  #hlc;

  constructor({ kv, settings, deviceId, now = Date.now }) {
    super();
    Object.assign(this, { kv, settings, deviceId });
    this.#hlc = new HLC(now);
  }

  async load() {
    this.#items = clean((await this.kv.get('sync'))?.items);
    for (const item of Object.values(this.#items)) this.#hlc.observe(item);
  }

  /** Everything we hold, to hand to another device. */
  get items() { return structuredClone(this.#items); }

  /** The alias of each device that is still linked: device key -> alias. */
  get aliases() {
    return new Map(Object.entries(this.#items).filter(([k, i]) => DEVICE.test(k) && i.v !== null)
      .map(([k, i]) => [k.slice(2), i.v]));
  }

  alias(pub) { return this.#items[deviceKey(pub)]?.v; }

  /** The value held for `key` (undefined if none), without copying everything. */
  value(key) { return this.#items[key]?.v; }

  /** Our own changes: `patch` maps keys to new values. Returns the items that changed (to
   *  send on). Throws if a value is not acceptable. */
  async set(patch) {
    const changed = {};
    for (const [key, v] of Object.entries(patch)) {
      if (!known(key)) throw new Error(`not shared: ${key}`);
      if (!validValue(key, v)) throw new Error(`invalid value for ${key}`);
      const now = SHARED.includes(key) ? this.settings[key] : this.#items[key]?.v;
      if (same(now, v)) continue; // nothing changes
      if (READ.test(key) && now && compareStamps(v, now) <= 0) continue; // only moves forward
      const { ms, c } = this.#hlc.tick();
      changed[key] = { v, ms, c, by: this.deviceId };
    }
    return this.#take(changed, true);
  }

  /** Give every shared setting that has no stamp yet one, so that it travels too. */
  async seed() {
    const changed = {};
    for (const key of SHARED) {
      if (this.#items[key] || !validValue(key, this.settings[key])) continue;
      const { ms, c } = this.#hlc.tick();
      changed[key] = { v: this.settings[key], ms, c, by: this.deviceId };
    }
    return this.#take(changed, true);
  }

  /** First link: this device has just become part of another one's identity, so that device's
   *  state replaces ours (merge would let a newer stamp of ours win). */
  async adopt(raw) {
    this.#items = {};
    const taken = await this.merge(raw);
    if (!Object.keys(taken).length) await this.kv.put('sync', { items: this.#items });
    return taken;
  }

  /** Items from another device: the newer ones win. Returns the ones we accepted. */
  async merge(raw) {
    const incoming = clean(raw);
    const accepted = {};
    for (const [key, item] of Object.entries(incoming)) {
      const mine = this.#items[key];
      const wins = READ.test(key) ? !mine || compareStamps(item.v, mine.v) > 0
        : !mine || newer(item, mine) > 0;
      if (wins) accepted[key] = item;
      this.#hlc.observe(item);
    }
    return this.#take(accepted, false);
  }

  async #take(items, local) {
    const keys = Object.keys(items);
    if (!keys.length) return {};
    Object.assign(this.#items, items);
    for (const key of keys) if (SHARED.includes(key)) this.settings[key] = items[key].v;
    await this.kv.put('sync', { items: this.#items });
    if (keys.some((k) => SHARED.includes(k))) await saveSettings(this.kv, this.settings);
    this.emit('change', keys, local);
    return items;
  }
}
