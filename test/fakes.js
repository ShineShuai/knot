// In-memory stand-ins for the network so Room logic can be tested in Node.
import { Emitter } from '../src/util/emitter.js';
import { randomBytes, toB64u } from '../src/util/bytes.js';
import {
  PacketParser, decodePublish, encodeConnack, encodePublish, encodeSuback,
} from '../src/net/mqtt.js';

const sdpInfo = (ufrag) => (
  {
    ufrag,
    pwd: 'p'.repeat(22),
    mid: '0',
    fingerprint: randomBytes(32),
    sctpPort: 5000,
    maxMessage: 262144,
    candidates: [],
  }
);

/** Same surface as PeerLink; two linked FakeLinks behave like an open WebRTC connection. */
export class FakeLink extends Emitter {
  static registry = new Map();
  static corruptFiles = false;
  state = 'connecting';
  peer = null;

  async createOffer() {
    this.token = toB64u(randomBytes(6));
    FakeLink.registry.set(this.token, this);
    return sdpInfo(this.token);
  }
  async acceptOffer(sdp) {
    this.peer = FakeLink.registry.get(sdp.ufrag);
    this.peer.peer = this;
    return sdpInfo(`a${this.peer.token}`);
  }
  async acceptAnswer() { queueMicrotask(() => { this.#open(); this.peer?.#open(); }); }
  #open() { if (this.state === 'connecting') { this.state = 'open'; this.emit('open'); } }

  async stats() { return { local: 'host', remote: 'srflx', protocol: 'udp', rtt: 12 }; }

  sendChat(text) {
    if (this.state !== 'open') throw new Error('link is not open');
    const p = this.peer; setTimeout(() => p.state === 'open' && p.emit('chat', text), 0);
  }
  async sendFile(data) {
    if (this.state !== 'open') throw new Error('link closed');
    const p = this.peer;
    if (typeof data !== 'string' && FakeLink.corruptFiles && data.length > 8) {
      data = Uint8Array.from(data);
      data[8] ^= 0xff;
    }
    setTimeout(
      () => p.state === 'open' && p.emit(
        'file',
        typeof data === 'string' ? data : data.buffer.slice(
          data.byteOffset,
          data.byteOffset + data.length,
        ),
      ),
      0,
    );
  }
  close() {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.emit('close');
    this.peer?.close();
  }
}

/** A link that never connects (simulates P2P being impossible). */
export class DeadLink extends FakeLink {
  async acceptAnswer() {}
}

/** An in-memory MQTT broker; WebSocket-compatible class bound to it via `ws()`.
 *  `mode`: 'ok' | 'refuse' (SUBACK failure) | 'silent' (no SUBACK) | 'drop' (acks, no relay). */
export class FakeBroker {
  sockets = new Set();
  constructor(mode = 'ok') { this.mode = mode; }
  ws() {
    const broker = this;
    return class FakeWS {
      constructor() {
        this.topics = new Set();
        this.parser = new PacketParser();
        broker.sockets.add(this);
        queueMicrotask(() => this.onopen?.());
      }
      send(bytes) { for (const p of this.parser.push(bytes)) broker.handle(this, p); }
      close() { broker.sockets.delete(this); queueMicrotask(() => this.onclose?.()); }
      deliver(bytes) {
        queueMicrotask(
          () => this.onmessage?.(
            { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }
          ),
        );
      }
    };
  }
  handle(sock, { type, flags, body }) {
    if (type === 1) sock.deliver(encodeConnack(0));
    else if (type === 8) {
      if (this.mode === 'silent') return;
      if (this.mode === 'refuse') return sock.deliver(encodeSuback((body[0] << 8) | body[1], 0x80));
      const n = (body[2] << 8) | body[3];
      sock.topics.add(new TextDecoder().decode(body.subarray(4, 4 + n)));
      sock.deliver(encodeSuback((body[0] << 8) | body[1]));
    }
    else if (type === 3 && this.mode !== 'drop') {
      const { topic, payload } = decodePublish({ flags, body });
      for (const s of this.sockets) if (s.topics.has(topic)) s.deliver(
        encodePublish(topic, payload),
      );
    }
  }
}

/** Wait for `cond`. Failing is slow, passing is not: the limit is generous (a loaded CI machine
 *  needs seconds for what takes milliseconds here), and a smaller `ms` cannot lower it. */
const PATIENCE_MS = Number(process.env.KNOT_TEST_PATIENCE_MS) || 20_000;
export async function until(cond, ms = PATIENCE_MS) {
  ms = Math.max(ms, PATIENCE_MS);
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}
