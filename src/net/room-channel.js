// Rendezvous + relay over public MQTT brokers. All payloads are AES-GCM sealed
// with the room key, so brokers only see opaque bytes on an unguessable topic.
//
// Topics (under <prefix>/<roomId>/):  p = presence, s/<peerId> = signaling to one
// peer, m = relayed chat messages.
// Events: 'presence'({id,pub,name,pv,app}), 'signal'(bytes), 'relay'(bytes),
// 'status'({connected,total})
import { Emitter } from '../util/emitter.js';
import { fromB64u, fromUtf8, toB64u, utf8 } from '../util/bytes.js';
import { peerIdOf } from '../crypto/identity.js';
import { verifyCert } from '../crypto/delegation.js';
import { open, seal } from '../crypto/room-keys.js';
import { MqttClient } from './mqtt.js';
import { DOWN_RETRY_MS } from './broker-health.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SEEN_LIMIT = 2000;

export class RoomChannel extends Emitter {
  #clients = new Map(); // broker url -> connected MqttClient
  // sealed-payload ids already handled (same message arrives via every broker)
  #seen = new Set();
  #running = false;
  #nudges = new Set(); // connections that wait to retry: `wake` cuts the wait short

  /** `health`: optional BrokerHealth; fast brokers connect first, known-down ones are retried
   *  slowly. */
  constructor({ roomId, aes, selfId, brokers, topicPrefix, WS, health = null }) {
    super();
    Object.assign(this, { roomId, selfId, brokers, health });
    this.aes = aes;
    this.WS = WS;
    this.base = `${topicPrefix}/${roomId}`;
  }

  get status() { return { connected: this.#clients.size, total: this.brokers.length }; }

  start() {
    this.#running = true;
    for (const url of this.health?.order(this.brokers) ?? this.brokers) this.#supervise(url);
  }

  stop() {
    this.#running = false;
    for (const c of this.#clients.values()) c.close();
  }

  /** The page was away or the network changed: a socket can be dead without saying so. Drop
   *  them all and reconnect now; a connection that waits to retry does not wait any longer. */
  wake() {
    for (const client of [...this.#clients.values()]) client.close();
    for (const nudge of [...this.#nudges]) nudge();
  }

  // ---- sending ---------------------------------------------------------------

  /** Say we are here. A linked device adds its certificate (so others see whose device it is
   *  before any link is up) and a device with an alias of its own adds that. */
  announce({ pub, name, cert, alias, pv, app }) {
    const body = {
      pub: toB64u(pub), name, ...(cert ? { cert } : {}), ...(alias ? { al: alias } : {}),
      ...(pv ? { pv } : {}), ...(app ? { app } : {}),
    };
    return this.#publish(`${this.base}/p`, utf8.encode(JSON.stringify(body)));
  }
  sendSignal(peerId, bytes) { return this.#publish(`${this.base}/s/${peerId}`, bytes); }
  sendRelay(bytes) { return this.#publish(`${this.base}/m`, bytes); }

  async #publish(topic, plain) {
    if (!this.#clients.size) return 0;
    const sealed = await seal(this.aes, plain, utf8.encode(topic));
    for (const c of this.#clients.values()) c.publish(topic, sealed);
    return this.#clients.size;
  }

  // ---- receiving -------------------------------------------------------------

  async #onMessage(topic, sealed) {
    const key = toB64u(sealed.subarray(0, 12)); // the random IV identifies a sealed payload
    if (this.#seen.has(key)) return;
    this.#seen.add(key);
    if (this.#seen.size > SEEN_LIMIT) this.#seen.delete(this.#seen.values().next().value);
    let plain;
    // not ours / forged
    try { plain = await open(this.aes, sealed, utf8.encode(topic)); } catch { return; }
    if (topic === `${this.base}/p`) return this.#onPresence(plain);
    if (topic === `${this.base}/s/${this.selfId}`) return this.emit('signal', plain);
    if (topic === `${this.base}/m`) return this.emit('relay', plain);
  }

  async #onPresence(plain) {
    try {
      const { pub, name, cert, al, pv, app } = JSON.parse(fromUtf8(plain));
      const bytes = fromB64u(pub);
      const id = await peerIdOf(bytes);
      // whose device this is: only if the certificate is valid and is for exactly this key
      const member = cert && cert.d === pub ? await verifyCert(cert) : null;
      const alias = typeof al === 'string' && al.length > 0 && al.length <= 16 ? al : undefined;
      // what their app speaks: no number means a version from before it was announced
      const level = Number.isSafeInteger(pv) && pv >= 1 && pv <= 1000 ? pv : 1;
      const build = typeof app === 'string' && /^[\w.+-]{1,16}$/.test(app) ? app : undefined;
      if (id !== this.selfId) this.emit('presence', {
        id, pub: bytes, name: String(name).slice(0, 32), pv: level,
        ...(member ? { member, device: cert.n } : {}), ...(alias ? { alias } : {}),
        ...(build ? { app: build } : {}),
      });
    } catch { /* malformed presence from a room member: ignore */ }
  }

  // ---- broker connections ------------------------------------------------------

  /** Keep one broker connection alive, reconnecting with jittered exponential backoff. */
  async #supervise(url) {
    let delay = 1000;
    while (this.#running) {
      if (this.health?.isDown(url)) { // its probe failed: look again slowly, or when it is back
        await this.health.untilUp(url, DOWN_RETRY_MS * (0.5 + Math.random()));
        if (!this.#running) return;
      }
      const client = new MqttClient(url, { WS: this.WS });
      const t0 = Date.now();
      try {
        await client.connect();
        const ms = Date.now() - t0;
        delay = 1000;
        const closed = new Promise((resolve) => client.on('close', resolve));
        client.on('message', (topic, payload) => this.#onMessage(topic, payload));
        this.#clients.set(url, client);
        this.emit('status', this.status);
        const topics = [`${this.base}/p`, `${this.base}/s/${this.selfId}`, `${this.base}/m`];
        const wait = Math.max(15_000, 3 * ms); // far brokers answer late, they are not broken
        try { await Promise.all(topics.map((topic) => client.subscribe(topic, wait))); }
        catch (err) { // refused or never answered: it takes our messages but would not pass them on
          if (client.connected) this.health?.fail(url, `no relay: ${err.message}`);
          throw err;
        }
        this.health?.report(url, ms);
        await closed;
      } catch { /* unreachable broker: back off and retry */ }
      this.#clients.delete(url);
      client.close();
      this.emit('status', this.status);
      if (!this.#running) return;
      let nudge;
      const nudged = new Promise((resolve) => { nudge = () => { delay = 500; resolve(); }; });
      this.#nudges.add(nudge);
      await Promise.race([sleep(delay * (0.5 + Math.random())), nudged]);
      this.#nudges.delete(nudge);
      delay = Math.min(delay * 2, 30000);
    }
  }
}
