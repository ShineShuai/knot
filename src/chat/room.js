// A Room ties everything together for one chat room:
//
//   identity + secret --> keys --> RoomChannel (brokers: presence, signaling, relay)
//                              \-> PeerLink per member (WebRTC data channels)
//   chat messages: signed envelopes -> MessageLog -> MessageStore (IndexedDB)
//   files: FileTransfer over each link's file channel
//
// Two ways to connect peers, both optional and combinable:
//   * automatic: peers with the room secret find each other through brokers
//   * manual:    createInvite() / answerOffer() / acceptAnswer() exchange codes
//
// Events: 'message'(envelope), 'peers'(list), 'brokers'({connected,total})
import { Emitter } from '../util/emitter.js';
import { HLC } from '../util/hlc.js';
import { RateLimiter } from '../util/rate.js';
import { fromUtf8, randomBytes, toB64u, utf8 } from '../util/bytes.js';
import { peerIdOf } from '../crypto/identity.js';
import { deriveRoomKeys } from '../crypto/room-keys.js';
import { iceServersFrom } from '../config.js';
import {
  encodeCode,
  shortAuthString,
  signHandshake,
  unpackHandshake,
  verifyHandshake,
} from '../net/handshake.js';
import { PeerLink } from '../net/peer-link.js';
import { RoomChannel } from '../net/room-channel.js';
import { FileTransfer } from '../files/transfer.js';
import { authorIdOf, createEnvelope, verifyEnvelope } from './envelope.js';
import { MessageLog } from './log.js';
import { MessageStore } from './message-store.js';

const SEEN_SESSIONS_LIMIT = 200;
const MAX_FRAME_BYTES = 48 * 1024; // keep chat frames well under every browser's SCTP limit
const REDIAL_MS = 10000;

export class Room extends Emitter {
  /** peerId -> { id, pub, name, link, via:'broker'|'manual', state:'connecting'|'p2p', sas } */
  peers = new Map();
  /** peerId -> { pub, name, seen } for everyone announcing on the brokers */
  members = new Map();

  #aes; #store; #channel = null; #timers = new Set();
  #pending = new Map();      // session -> { link, offer, peer|null } handshakes awaiting an answer
  #seenSessions = new Set(); // offers already answered (replay protection)
  #dialedAt = new Map();

  static async open(opts) {
    const keys = await deriveRoomKeys(opts.secret);
    const room = new Room(opts, keys);
    await room.#load();
    return room;
  }

  constructor({ identity, secret, label, kv, settings, iceServers, linkFactory, WS }, keys) {
    super();
    this.identity = identity;
    this.secret = secret;
    this.label = label;
    this.settings = settings; // live object: edits in Settings apply to new connections
    this.id = keys.id;
    this.#aes = keys.aes;
    this.hlc = new HLC();
    this.log = new MessageLog(settings.logCap);
    this.files = new FileTransfer(
      { chunkSize: settings.chunkSize, maxBytes: settings.maxFileBytes },
    );
    this.#store = new MessageStore(kv, this.id);
    this.iceServers = iceServers ?? (() => iceServersFrom(settings));
    this.linkFactory = linkFactory ?? ((o) => new PeerLink(o));
    this.WS = WS;
  }

  get #name() { return this.settings.name || `anon-${this.identity.id.slice(0, 4)}`; }

  /** Everyone we know of in this room, for display. state: p2p | relay | connecting | seen */
  get peerList() {
    const viaRelay = (id) => !!this.#channel && this.settings.relayFallback && this.#isFresh(
      this.members.get(id) ?? { seen: 0 },
    );
    const rows = [...this.peers.values()].map(({ id, name, state, via, sas }) => ({
      id, name, via, sas, state: state === 'p2p' || !viaRelay(id) ? state : 'relay',
    }));
    for (const [id, m] of this.members) {
      if (!this.peers.has(id) && this.#isFresh(m)) rows.push(
        { id, name: m.name, state: viaRelay(id) ? 'relay' : 'seen', via: 'broker', sas: null },
      );
    }
    return rows;
  }

  async #load() {
    for (const env of await this.#store.loadAll()) { this.log.add(env); this.hlc.observe(env); }
    await this.#store.remove(this.log.trim());
  }

  // ---- lifecycle -------------------------------------------------------------------

  start() {
    if (!this.settings.brokersEnabled || !this.settings.brokers.length) return;
    this.#channel = new RoomChannel({
      roomId: this.id, aes: this.#aes, selfId: this.identity.id, WS: this.WS,
      brokers: this.settings.brokers, topicPrefix: this.settings.topicPrefix,
    });
    this.#channel.on('presence', (p) => this.#onPresence(p));
    this.#channel.on('signal', (bytes) => this.#onSignal(bytes));
    this.#channel.on('relay', (bytes) => this.#onRelay(bytes));
    this.#channel.on(
      'status',
      (s) => { this.emit('brokers', s); if (s.connected) this.#announce(); },
    );
    this.#channel.start();
    this.#every(this.settings.presenceIntervalMs, () => this.#announce());
  }

  stop() {
    for (const t of this.#timers) { clearInterval(t); clearTimeout(t); }
    this.#channel?.stop();
    for (const { link } of this.#pending.values()) link.close();
    for (const { link } of this.peers.values()) link.close();
  }

  #every(ms, fn) { const t = setInterval(fn, ms); t.unref?.(); this.#timers.add(t); }

  // ---- sending ------------------------------------------------------------------------

  async sendText(text) {
    text = text.trim();
    if (!text) return null;
    if (text.length > this.settings.maxTextLength) throw new Error('Message too long');
    return this.#publish('text', text);
  }

  async shareFile(file) {
    if (file.size > this.settings.maxFileBytes) throw new Error('File too large');
    return this.#publish('file', await this.files.share(file));
  }

  /** Fetch a shared file directly from its author. Resolves to a Blob. */
  async downloadFile(env, onProgress) {
    const own = authorIdOf(env) === this.identity.id && this.files.local(env.body.id);
    if (own) return own;
    const link = this.peers.get(authorIdOf(env))?.link;
    if (link?.state !== 'open') throw new Error('The sender is not connected right now');
    return this.files.download(link, env.body, onProgress);
  }

  async #publish(kind, body) {
    const env = await createEnvelope(this.identity, this.hlc, this.id, kind, body, this.#name);
    await this.#accept(env, null);
    this.#sendToPeers(env);
    if (this.#needsRelay()) this.#channel.sendRelay(utf8.encode(JSON.stringify(env)));
    return env;
  }

  #sendToPeers(env, exceptId = null) {
    const frame = JSON.stringify({ t: 'msg', e: env });
    for (const p of this.peers.values()) {
      if (p.state === 'p2p' && p.id !== exceptId) {
        try { p.link.sendChat(frame); } catch { /* link dying */ }
      }
    }
  }

  /** Relay through brokers only while some known member has no direct link. */
  #needsRelay() {
    return !!this.#channel && this.settings.relayFallback
      && [...this.members].some(
        ([id, m]) => this.#isFresh(m) && this.peers.get(id)?.state !== 'p2p',
      );
  }

  #isFresh(member) { return Date.now() - member.seen < 3 * this.settings.presenceIntervalMs; }

  // ---- receiving -------------------------------------------------------------------------

  async #ingest(env, source) {
    if (!env?.id || this.log.has(env.id)) return false;
    const limits = {
      maxText: this.settings.maxTextLength,
      maxFileBytes: this.settings.maxFileBytes,
    };
    if (!(await verifyEnvelope(env, this.id, limits))) return false;
    return this.#accept(env, source);
  }

  async #accept(env, source) {
    if (!this.log.add(env)) return false;
    this.hlc.observe(env);
    const removed = this.log.trim();
    await Promise.all(
      [this.#store.save(env), this.#store.remove(removed)],
    ).catch((err) => console.error('could not save message', err));
    if (!removed.includes(env)) this.emit('message', env);
    if (source) this.#sendToPeers(env, source.id); // gossip: heals meshes with a missing link
    return true;
  }

  async #onRelay(bytes) {
    try {
      await this.#ingest(JSON.parse(fromUtf8(bytes)), null);
    } catch { /* not a valid message */ }
  }

  async #onChat(entry, raw) {
    if (!entry.limiter.allow()) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m?.t === 'msg') await this.#ingest(m.e, entry);
    else if (m?.t === 'have' && Array.isArray(m.ids)) this.#sendGive(
      entry.link,
      m.ids.filter((s) => typeof s === 'string'),
      !!m.full,
    );
    else if (m?.t === 'give' &&
      Array.isArray(m.es)) for (const e of m.es.slice(0, 50)) await this.#ingest(
      e,
      entry,
    );
  }

  // ---- history sync (on every new link) -------------------------------------------------------

  #sendHave(link) {
    const window = this.settings.syncWindow;
    link.sendChat(
      JSON.stringify(
        { t: 'have', ids: this.log.recentIds(window), full: this.log.size >= window },
      ),
    );
  }

  #sendGive(link, ids, full) {
    const missing = this.log.missingFor(ids.slice(0, this.settings.syncWindow * 2), full);
    let batch = [], size = 0;
    const flush = () => {
      if (batch.length) link.sendChat(JSON.stringify({ t: 'give', es: batch }));
      batch = [];
      size = 0;
    };
    try {
      for (const env of missing) {
        const n = JSON.stringify(env).length;
        if (size + n > MAX_FRAME_BYTES || batch.length >= 50) flush();
        batch.push(env); size += n;
      }
      flush();
    } catch { /* link closed mid-sync; the next link will retry */ }
  }

  // ---- links
  // ---------------------------------------------------------------------------------------

  #newLink() {
    return this.linkFactory(
      { iceServers: this.iceServers(), gatherTimeoutMs: this.settings.gatherTimeoutMs },
    );
  }

  /** Register a link for a known peer. Returns null (and closes `link`) if that peer is already
   * connected. */
  #attach(link, peer, via) {
    const existing = this.peers.get(peer.id);
    if (existing?.state === 'p2p') { link.close(); return null; }
    existing?.link.close();
    const entry = {
      ...peer,
      link,
      via,
      state: 'connecting',
      sas: null,
      limiter: new RateLimiter(this.settings.messagesPerSecond),
    };
    this.peers.set(peer.id, entry);
    const ttl = via === 'manual' ? this.settings.inviteTtlMs : this.settings.connectTimeoutMs;
    const timer = setTimeout(() => entry.state === 'connecting' && link.close(), ttl);
    timer.unref?.();
    link.on('open', () => {
      clearTimeout(timer);
      entry.state = 'p2p';
      this.#emitPeers();
      this.#sendHave(link);
      this.#announce();
    });
    link.on('chat', (raw) => this.#onChat(entry, raw));
    link.on('file', (data) => this.files.onFrame(link, data));
    link.on('close', () => {
      clearTimeout(timer);
      if (this.peers.get(peer.id) !== entry) return;
      this.peers.delete(peer.id);
      this.#emitPeers();
      this.#announce();
    });
    this.#emitPeers();
    return entry;
  }

  #emitPeers() { this.emit('peers', this.peerList); }

  #watchPending(offer, link, peer, ttlMs) {
    const key = toB64u(offer.session);
    this.#pending.set(key, { link, offer, peer });
    const timer = setTimeout(() => {
      if (this.#pending.delete(key) && !peer) link.close(); // unanswered manual invite
    }, ttlMs);
    timer.unref?.();
    this.#timers.add(timer);
  }

  async #newOffer({ roomSecret }) {
    const link = this.#newLink();
    try {
      const sdp = await link.createOffer();
      const offer = await signHandshake(this.identity, {
        kind: 'offer', session: randomBytes(8), ts: Date.now(), name: this.#name, roomSecret, sdp,
      });
      return { link, offer };
    } catch (err) { link.close(); throw err; }
  }

  /** Verify an offer and build our answer. Shared by manual and broker paths. */
  async #answer(offer, via) {
    const peer = { id: await peerIdOf(offer.pub), pub: offer.pub, name: offer.name };
    if (peer.id === this.identity.id) throw new Error('That code was made by this device');
    const session = toB64u(offer.session);
    if (this.#seenSessions.has(session)) throw new Error('This code was already used');
    this.#seenSessions.add(session);
    if (this.#seenSessions.size > SEEN_SESSIONS_LIMIT) this.#seenSessions.delete(
      this.#seenSessions.values().next().value,
    );

    const link = this.#newLink();
    const entry = this.#attach(link, peer, via);
    if (!entry) throw new Error('Already connected to this peer');
    try {
      const sdp = await link.acceptOffer(offer.sdp);
      const answer = await signHandshake(this.identity, {
        kind: 'answer', session: offer.session, ts: Date.now(),
        name: this.#name, roomSecret: null, sdp,
      });
      entry.sas = await shortAuthString(offer.sdp.fingerprint, sdp.fingerprint);
      this.#emitPeers();
      return { answer, sas: entry.sas };
    } catch (err) { link.close(); throw err; }
  }

  /** Connect a pending link to the answer. Returns false if the answer matches nothing we sent. */
  async #finish(answer) {
    const key = toB64u(answer.session);
    const pending = this.#pending.get(key);
    if (!pending) return false;
    this.#pending.delete(key);
    const id = await peerIdOf(answer.pub);
    if (pending.peer && pending.peer.id !== id) { pending.link.close(); return false; }
    const entry = pending.peer ? this.peers.get(id) : this.#attach(
      pending.link,
      { id, pub: answer.pub, name: answer.name },
      'manual',
    );
    if (entry?.link !== pending.link) { pending.link.close(); return false; }
    entry.sas = await shortAuthString(pending.offer.sdp.fingerprint, answer.sdp.fingerprint);
    this.#emitPeers();
    await pending.link.acceptAnswer(answer.sdp);
    return true;
  }

  // ---- manual pairing (no server needed)
  // ---------------------------------------------------------------

  /** Step 1 (inviter): returns a code to hand to the other person. */
  async createInvite() {
    const { link, offer } = await this.#newOffer({ roomSecret: this.secret });
    this.#watchPending(offer, link, null, this.settings.inviteTtlMs);
    return { code: encodeCode(offer), session: toB64u(offer.session) };
  }

  /** Step 2 (invitee, in the room created from the offer's secret): returns the reply code. */
  async answerOffer(offer) {
    await verifyHandshake(offer);
    const { answer, sas } = await this.#answer(offer, 'manual');
    return { code: encodeCode(answer), sas };
  }

  /** Step 3 (inviter): feed the reply code back; the link then connects by itself. */
  async acceptAnswer(answer) {
    await verifyHandshake(answer);
    if (!(await this.#finish(answer))) throw new Error(
      'No open invite matches this reply (expired or already used)',
    );
  }

  // ---- automatic pairing through brokers
  // --------------------------------------------------------------------

  #announce() { this.#channel?.announce({ pub: this.identity.pub, name: this.#name }); }

  async #onPresence({ id, pub, name }) {
    const isNew = !this.members.has(id);
    this.members.set(id, { pub, name, seen: Date.now() });
    if (isNew) { this.#emitPeers(); this.#announceSoon(); }
    const state = this.peers.get(id)?.state;
    // Glare rule: the peer with the smaller id always makes the offer.
    if (!state && this.identity.id < id) await this.#dial({ id, pub, name });
  }

  #announceSoon() {
    if (this.#announceTimer) return;
    this.#announceTimer = setTimeout(
      () => { this.#announceTimer = null; this.#announce(); },
      100 + Math.random() * 400,
    );
    this.#announceTimer.unref?.();
  }
  #announceTimer = null;

  async #dial(peer) {
    if (Date.now() - (this.#dialedAt.get(peer.id) ?? 0) < REDIAL_MS) return;
    this.#dialedAt.set(peer.id, Date.now());
    try {
      const { link, offer } = await this.#newOffer({ roomSecret: null });
      if (!this.#attach(link, peer, 'broker')) return;
      this.#watchPending(offer, link, peer, this.settings.connectTimeoutMs);
      await this.#channel.sendSignal(peer.id, offer.wire);
    } catch { /* retried at the next presence announcement */ }
  }

  async #onSignal(bytes) {
    try {
      const h = unpackHandshake(bytes);
      await verifyHandshake(h);
      if (h.kind === 'answer') return void (await this.#finish(h));
      const { answer } = await this.#answer(h, 'broker');
      await this.#channel.sendSignal(await peerIdOf(h.pub), answer.wire);
    } catch { /* bad, stale or duplicate signal: ignore */ }
  }
}
