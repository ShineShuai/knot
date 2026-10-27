// A pending request to join an owner-run room, made from a join link.
// Events: 'status'('connecting' | 'waiting' | 'declined' | 'offline' | 'timeout' | 'approved'),
//         'approved'({ secret, label, admit })
import { Emitter } from '../util/emitter.js';
import { newBoxKey } from '../crypto/box.js';
import { RoomChannel } from '../net/room-channel.js';
import { lobbyKeys, makeRequest, readDecision } from './lobby.js';

const RESEND_MS = 20000; // the owner may not be online yet: keep knocking
const GIVE_UP_MS = 30 * 60 * 1000;

export class JoinRequest extends Emitter {
  status = 'connecting';
  #channel = null; #timer = null; #boxKey = null; #keys = null; #until = 0;

  /** `WS`: WebSocket constructor (tests pass a fake). */
  constructor({ identity, lobbySecret, ownerId, name, greeting, settings, WS }) {
    super();
    Object.assign(this, { identity, lobbySecret, ownerId, name, greeting, settings, WS });
  }

  async start() {
    const { settings } = this;
    if (!settings.brokersEnabled || !settings.brokers.length) return this.#set('offline');
    this.#keys = await lobbyKeys(this.lobbySecret, this.ownerId);
    this.#boxKey = await newBoxKey();
    this.#channel = new RoomChannel({
      roomId: this.#keys.id, aes: this.#keys.aes, selfId: this.identity.id, WS: this.WS,
      brokers: settings.brokers, topicPrefix: settings.topicPrefix,
    });
    this.#channel.on('signal', (bytes) => this.#onSignal(bytes));
    this.#channel.on('status', (s) => { if (s.connected) this.#send(); });
    this.#until = Date.now() + GIVE_UP_MS;
    this.#channel.start();
    this.#timer = setInterval(() => this.#send(), RESEND_MS);
    this.#timer.unref?.();
    return undefined;
  }

  stop() {
    clearInterval(this.#timer);
    this.#channel?.stop();
  }

  #set(status) { this.status = status; this.emit('status', status); }

  async #send() {
    if (this.status !== 'connecting' && this.status !== 'waiting') return;
    if (Date.now() > this.#until) { this.stop(); return this.#set('timeout'); }
    const request = await makeRequest(this.identity, {
      lobbyId: this.#keys.id, name: this.name, greeting: this.greeting,
      boxPub: this.#boxKey.pub,
    });
    if (await this.#channel.sendSignal(this.ownerId, request)) this.#set('waiting');
    return undefined;
  }

  async #onSignal(bytes) {
    const decision = await readDecision(bytes, {
      lobbyId: this.#keys.id, ownerId: this.ownerId, selfId: this.identity.id,
      boxKey: this.#boxKey,
    });
    if (!decision || this.status === 'approved' || this.status === 'declined') return;
    this.stop();
    if (decision.t === 'deny') return this.#set('declined');
    this.#set('approved');
    this.emit('approved', decision);
    return undefined;
  }
}
