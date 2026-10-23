// Minimal MQTT 3.1.1 client over WebSocket: CONNECT, SUBSCRIBE and PUBLISH at
// QoS 0, keep-alive pings. That is all a rendezvous channel needs, and it keeps
// the app free of third-party code.
import { Emitter } from '../util/emitter.js';
import { concat, fromUtf8, randomBytes, toB64u, utf8 } from '../util/bytes.js';

const TYPE = { CONNECT: 1, CONNACK: 2, PUBLISH: 3, PINGREQ: 12, DISCONNECT: 14 };

const varInt = (n) => {
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 128; out.push(b); } while (n > 0);
  return Uint8Array.from(out);
};
const lp = (value) => {
  const b = typeof value === 'string' ? utf8.encode(value) : value;
  return concat(Uint8Array.of(b.length >> 8, b.length & 255), b);
};
const packet = (byte0, body) => concat(Uint8Array.of(byte0), varInt(body.length), body);

export const encodeConnect = (clientId, keepAliveSec) =>
  packet(
    TYPE.CONNECT << 4,
    concat(
      lp('MQTT'),
      Uint8Array.of(4, 0x02, keepAliveSec >> 8, keepAliveSec & 255),
      lp(clientId),
    ),
  );
export const encodeSubscribe = (packetId, topic) =>
  packet(0x82, concat(Uint8Array.of(packetId >> 8, packetId & 255), lp(topic), Uint8Array.of(0)));
export const encodePublish = (topic, payload) => packet(
  TYPE.PUBLISH << 4,
  concat(lp(topic), payload),
);
export const encodeConnack = (code = 0) => Uint8Array.of(TYPE.CONNACK << 4, 2, 0, code);
export const PING = Uint8Array.of(TYPE.PINGREQ << 4, 0);
export const DISCONNECT = Uint8Array.of(TYPE.DISCONNECT << 4, 0);

/** Reassembles MQTT packets from arbitrary WebSocket frames (they may split or merge packets). */
export class PacketParser {
  #buf = new Uint8Array(0);

  push(chunk) {
    this.#buf = concat(this.#buf, chunk);
    const out = [];
    for (let p = this.#next(); p; p = this.#next()) out.push(p);
    return out;
  }

  #next() {
    const b = this.#buf;
    let len = 0, mult = 1, i = 1;
    for (;;) {
      if (i >= b.length) return null;
      const digit = b[i++];
      len += (digit & 127) * mult;
      if (!(digit & 128)) break;
      mult *= 128;
      if (mult > 128 ** 3) throw new Error('malformed MQTT length');
    }
    if (b.length < i + len) return null;
    const pkt = { type: b[0] >> 4, flags: b[0] & 15, body: b.slice(i, i + len) };
    this.#buf = b.slice(i + len);
    return pkt;
  }
}

export function decodePublish({ flags, body }) {
  const topicLength = (body[0] << 8) | body[1];
  const qosBytes = (flags >> 1) & 3 ? 2 : 0; // packet id present for QoS > 0
  return {
    topic: fromUtf8(body.subarray(2, 2 + topicLength)),
    payload: body.slice(2 + topicLength + qosBytes),
  };
}

/** Events: 'message'(topic, payload:Uint8Array), 'close'. */
export class MqttClient extends Emitter {
  connected = false;
  #ws; #parser = new PacketParser(); #pingTimer; #lastRx = 0; #nextId = 1; #closed = false;

  constructor(
    url,
    { WS = globalThis.WebSocket, keepAliveSec = 30, connectTimeoutMs = 8000 } = {},
  ) {
    super();
    Object.assign(this, { url });
    this.opts = { WS, keepAliveSec, connectTimeoutMs };
  }

  connect() {
    const { WS, keepAliveSec, connectTimeoutMs } = this.opts;
    return new Promise((resolve, reject) => {
      const fail = (err) => { clearTimeout(timer); this.close(); reject(err); };
      const timer = setTimeout(() => fail(new Error('connect timeout')), connectTimeoutMs);
      const ws = (this.#ws = new WS(this.url, 'mqtt'));
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => ws.send(encodeConnect(`k-${toB64u(randomBytes(9))}`, keepAliveSec));
      ws.onerror = () => fail(new Error('socket error'));
      ws.onclose = () => (
        this.connected ? this.close() : fail(new Error('closed before CONNACK'))
      );
      ws.onmessage = (e) => {
        this.#lastRx = Date.now();
        for (const p of this.#parser.push(new Uint8Array(e.data))) {
          if (p.type === TYPE.CONNACK) {
            if (p.body[1] !== 0) return fail(new Error(`broker refused (${p.body[1]})`));
            clearTimeout(timer);
            this.connected = true;
            this.#startPings(keepAliveSec);
            resolve();
          } else if (p.type === TYPE.PUBLISH) {
            const { topic, payload } = decodePublish(p);
            this.emit('message', topic, payload);
          }
        }
      };
    });
  }

  subscribe(topic) { this.#send(encodeSubscribe(this.#nextId++ & 0xffff, topic)); }
  publish(topic, payload) { this.#send(encodePublish(topic, payload)); }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#pingTimer);
    const wasConnected = this.connected;
    this.connected = false;
    const ws = this.#ws;
    try {
      if (wasConnected && (ws.readyState === undefined || ws.readyState === 1)) ws.send(
        DISCONNECT,
      );
      ws?.close();
    } catch { /* socket already gone */ }
    if (wasConnected) this.emit('close');
  }

  #send(bytes) { if (this.connected) this.#ws.send(bytes); }

  #startPings(keepAliveSec) {
    this.#lastRx = Date.now();
    this.#pingTimer = setInterval(() => {
      if (Date.now() - this.#lastRx > keepAliveSec * 2000) this.close();
      else this.#send(PING);
    }, keepAliveSec * 800);
    this.#pingTimer.unref?.();
  }
}
