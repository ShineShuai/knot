// Rendezvous + relay over public MQTT brokers. All payloads are AES-GCM sealed
// with the room key, so brokers only see opaque bytes on an unguessable topic.
//
// Topics (under <prefix>/<roomId>/):  p = presence, s/<peerId> = signaling to one
// peer, m = relayed chat messages.
// Events: 'presence'({id,pub,name}), 'signal'(bytes), 'relay'(bytes), 'status'({connected,total})
import { Emitter } from '../util/emitter.js';
import { fromB64u, fromUtf8, toB64u, utf8 } from '../util/bytes.js';
import { peerIdOf } from '../crypto/identity.js';
import { open, seal } from '../crypto/room-keys.js';
import { MqttClient } from './mqtt.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SEEN_LIMIT = 2000;

export class RoomChannel extends Emitter {
  #clients = new Map(); // broker url -> connected MqttClient
  // sealed-payload ids already handled (same message arrives via every broker)
  #seen = new Set();
  #running = false;

  constructor({ roomId, aes, selfId, brokers, topicPrefix, WS }) {
    super();
    Object.assign(this, { roomId, selfId, brokers });
    this.aes = aes;
    this.WS = WS;
    this.base = `${topicPrefix}/${roomId}`;
  }

  get status() { return { connected: this.#clients.size, total: this.brokers.length }; }

  start() {
    this.#running = true;
    for (const url of this.brokers) this.#supervise(url);
  }

  stop() {
    this.#running = false;
    for (const c of this.#clients.values()) c.close();
  }

  // ---- sending ---------------------------------------------------------------

  announce({ pub, name }) {
    return this.#publish(
      `${this.base}/p`,
      utf8.encode(JSON.stringify({ pub: toB64u(pub), name })),
    );
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
      const { pub, name } = JSON.parse(fromUtf8(plain));
      const bytes = fromB64u(pub);
      const id = await peerIdOf(bytes);
      if (id !== this.selfId) this.emit(
        'presence',
        { id, pub: bytes, name: String(name).slice(0, 32) },
      );
    } catch { /* malformed presence from a room member: ignore */ }
  }

  // ---- broker connections ------------------------------------------------------

  /** Keep one broker connection alive, reconnecting with jittered exponential backoff. */
  async #supervise(url) {
    let delay = 1000;
    while (this.#running) {
      const client = new MqttClient(url, { WS: this.WS });
      try {
        await client.connect();
        delay = 1000;
        client.on('message', (topic, payload) => this.#onMessage(topic, payload));
        const topics = [`${this.base}/p`, `${this.base}/s/${this.selfId}`, `${this.base}/m`];
        for (const topic of topics) client.subscribe(topic);
        this.#clients.set(url, client);
        this.emit('status', this.status);
        await new Promise((resolve) => client.on('close', resolve));
      } catch { /* unreachable broker: back off and retry */ }
      this.#clients.delete(url);
      client.close();
      this.emit('status', this.status);
      if (!this.#running) return;
      await sleep(delay * (0.5 + Math.random()));
      delay = Math.min(delay * 2, 30000);
    }
  }
}
