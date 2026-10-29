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
// Rooms with an owner (the creator) let in only those the owner admits: see roster.js and
// lobby.js. Rooms without one stay open to anyone holding the secret.
//
// Audio/video calls: see `room.call` (call/call.js); its signaling rides our chat links.
//
// Events: 'message'(envelope), 'peers'(list), 'brokers'({connected,total}),
//         'roster'(), 'requests'() (owner: join requests changed), 'removed'(),
//         'incoming'(envelope) (a message from someone else that is not read yet),
//         'unread'() (the unread count changed)
import { Emitter } from '../util/emitter.js';
import { HLC } from '../util/hlc.js';
import { RateLimiter } from '../util/rate.js';
import { concat, fromB64u, fromUtf8, sha256, toB64u, utf8 } from '../util/bytes.js';
import { deriveRoomKeys } from '../crypto/room-keys.js';
import { iceServersFrom } from '../config.js';
import { PeerLink } from '../net/peer-link.js';
import { RoomChannel } from '../net/room-channel.js';
import { CallManager } from '../call/call.js';
import { verifyCert } from '../crypto/delegation.js';
import { FileTransfer } from '../files/transfer.js';
import { PreviewCache } from '../files/preview-cache.js';
import {
  ADMIN_KINDS, authorIdOf, authorOfId, createEnvelope, delBody, editBody, isEmoji, quoteOf,
  reactBody, replyBody, unlinkBody, verifyEnvelope,
} from './envelope.js';
import { MessageLog, byStamp } from './log.js';
import { MessageStore } from './message-store.js';
import { OwnerDesk } from './owner-desk.js';
import { Pairing } from './pairing.js';
import { ReadMarks } from './read-marks.js';
import { RoomFiles } from './room-files.js';
import { Roster } from './roster.js';
import { lobbySecretOf } from './lobby.js';

const MAX_FRAME_BYTES = 48 * 1024; // keep chat frames well under every browser's SCTP limit
const DECORATIONS = ['edit', 'react']; // envelopes that ride on another message
const LINKED_COUNTER_BASE = 500_000;

export class Room extends Emitter {
  /** peerId -> { id, pub, name, link, via:'broker'|'manual', state:'connecting'|'p2p', sas } */
  peers = new Map();
  /** peerId -> { pub, name, seen } for everyone announcing on the brokers */
  members = new Map();

  #chan; #store; #kv; #channel = null; #timers = new Set();
  #epoch = { n: 0, secret: null }; // key rotations: the channel keys depend on it
  #fileHub; #marks; #desk; #pairing; // what the room delegates, see the constructor
  #unlinked = new Set();     // "<member id>|<device key>" of every withdrawn certificate

  static async open(opts) {
    const keys = await deriveRoomKeys(opts.secret);
    const room = new Room(opts, keys);
    await room.#load();
    return room;
  }

  constructor(
    {
      identity, secret, label, owner = null, kv, settings, iceServers, linkFactory, WS, derive,
      callEnv = {}, health = null,
    },
    keys,
  ) {
    super();
    this.identity = identity;
    /** Membership, when the room has an owner (null: anyone with the secret may join). */
    this.roster = owner ? new Roster(owner) : null;
    this.removed = false; // the owner removed us
    this.secret = secret;
    this.label = label;
    this.settings = settings; // live object: edits in Settings apply to new connections
    this.id = keys.id; // the room's identity: signatures, storage; never changes
    this.#chan = { id: keys.id, aes: keys.aes }; // where we meet on the brokers: can rotate
    this.#kv = kv;
    // A linked device writes as the main identity: its counters start high, so their ids
    // cannot collide with the main device's.
    this.hlc = new HLC(Date.now, identity.cert ? LINKED_COUNTER_BASE : 0);
    this.log = new MessageLog(settings.logCap);
    this.previews = new PreviewCache(kv, this.id, settings.previewCacheBytes);
    this.files = new FileTransfer(
      {
        chunkSize: settings.chunkSize,
        maxBytes: settings.maxFileBytes,
        derive,
        lookup: (id) => this.previews.blob(id), // serve cached previews for others
      },
    );
    this.#store = new MessageStore(kv, this.id);
    this.iceServers = iceServers ?? (() => iceServersFrom(settings));
    this.linkFactory = linkFactory ?? ((o) => new PeerLink(o));
    this.WS = WS;
    this.health = health; // BrokerHealth: which brokers to try first, which to leave alone
    this.call = new CallManager({
      selfId: identity.id, settings, iceServers: () => this.iceServers(),
      send: (id, frame) => this.#sendCall(id, frame), ...callEnv,
    });
    // File transfers paused for a call end with it.
    this.call.on('change', () => {
      if (!this.call.joined && this.files.paused) this.setFileTransfer(true);
    });
    this.#fileHub = new RoomFiles(this, (...args) => this.#publish(...args));
    this.#marks = new ReadMarks({
      kv, roomId: this.id, log: this.log, isMine: (id) => this.isMine(id),
    });
    this.#marks.on('change', () => this.emit('unread'));
    this.#desk = new OwnerDesk(this, {
      publish: (...args) => this.#publish(...args),
      epoch: () => this.#epoch,
      applyEpoch: (n, secret) => this.#applyEpoch(n, secret),
      shareEpoch: (exceptId) => this.#shareEpoch(exceptId),
      chanSecret: () => this.#chanSecret(),
    });
    this.#pairing = new Pairing(this, {
      attach: (...args) => this.#attach(...args),
      newLink: () => this.#newLink(),
      emitPeers: () => this.#emitPeers(),
      admit: (...args) => this.#desk.admit(...args),
      channel: () => this.#channel,
      name: () => this.#name,
      track: (timer) => this.#timers.add(timer),
    });
  }

  /** Are files shared, served and fetched on this device? (Paused during a call on request.) */
  get fileTransfer() { return !this.files.paused; }

  /** Pause or resume file transfers on this device, e.g. to keep the bandwidth for a call.
   *  Text and thumbnails are not affected; previews and files wait until it is back on. */
  setFileTransfer(on) {
    if (this.files.paused === !on) return;
    this.files.paused = !on;
    this.emit('files');
  }

  get #name() { return this.settings.name || `anon-${this.identity.id.slice(0, 4)}`; }

  /** Everyone we know of in this room, for display. state: p2p | relay | connecting | seen */
  get peerList() {
    const viaRelay = (id) => !!this.#channel && this.settings.relayFallback && this.#isFresh(
      this.members.get(id) ?? { seen: 0 },
    );
    const owner = (id) => id === this.roster?.owner;
    const rows = [...this.peers.values()].map(({ id, name, state, via, sas, member }) => ({
      id, name, via, sas, member: member ?? id, owner: owner(member ?? id),
      state: state === 'p2p' || !viaRelay(id) ? state : 'relay',
    }));
    for (const [id, m] of this.members) {
      if (!this.peers.has(id) && this.#isFresh(m)) rows.push({
        id, name: m.name, state: viaRelay(id) ? 'relay' : 'seen', via: 'broker', sas: null,
        member: id, owner: owner(id),
      });
    }
    return rows;
  }

  async #load() {
    const stored = await this.#store.loadAll();
    for (const env of stored) { this.log.add(env); this.hlc.observe(env); }
    const trimmed = this.log.trim();
    const deleted = stored.filter((e) => !this.log.get(e.id) && !trimmed.includes(e));
    await this.#store.remove([...trimmed, ...deleted]); // deleted messages leave no content
    // An older version of the app may have saved this room without its owner. If our own
    // signature starts its membership chain, the room is ours: nobody can fake that.
    const ours = (e) => ADMIN_KINDS.includes(e.kind) && e.body.prev === ''
      && authorIdOf(e) === this.identity.id;
    if (!this.roster && stored.some(ours)) this.roster = new Roster(this.identity.id);
    this.roster?.load(stored);
    this.removed = !!this.roster?.revoked.has(this.identity.member);
    for (const e of this.log.where((x) => x.kind === 'unlink')) this.#noteUnlink(e);
    await this.#marks.load();
    const saved = await this.#kv.get(`epoch:${this.id}`);
    if (saved?.n) {
      this.#epoch = { n: saved.n, secret: fromB64u(saved.s) };
      this.#chan = await deriveRoomKeys(this.#chanSecret());
    }
  }


  /** Is this author id us: this device, or the main identity we write as (or one of its
   *  other devices, which write as the same identity)? */
  isMine(authorId) { return authorId === this.identity.member; }




  /** What the broker channel and lobby keys derive from: the room secret, mixed with the
   *  latest rotation's secret once a member has been removed. */
  #chanSecret() {
    return this.#epoch.n ? concat(this.secret, this.#epoch.secret) : this.secret;
  }

  get epoch() { return this.#epoch.n; }

  /** What another device of ours needs to join this room (sent sealed, see chat/devices.js). */
  exportState() {
    const { n, secret } = this.#epoch;
    return {
      secret: toB64u(this.secret), label: this.label, founder: this.roster?.founder ?? null,
      epoch: n ? { n, s: toB64u(secret) } : null,
    };
  }
  /** Id of the broker channel in use (changes with every rotation). */
  get channelId() { return this.#chan.id; }

  get isOwner() { return !!this.roster && this.roster.owner === this.identity.id; }
  get ownerId() { return this.roster?.owner ?? null; }

  /** Connection details of everyone we know, for the hold-V reveal:
   *  { id, name, state, via, net: { local, remote, protocol, rtt } | null } */
  async connectionInfo() {
    return Promise.all(this.peerList.map(async ({ id, name, state, via }) => {
      const link = this.peers.get(id)?.link;
      const net = state === 'p2p' ? await link?.stats?.().catch(() => null) ?? null : null;
      return { id, name, state, via, net };
    }));
  }

  // ---- what the room delegates (see the constructor) ----------------------------------------

  /** Messages from others that this device has not shown to its user yet. */
  get unread() { return this.#marks.count; }

  /** The user has seen everything up to now (they are looking at this room). */
  markRead() { return this.#marks.markRead(); }

  /** Share a file with the room; resolves to the signed message (see room-files.js). */
  shareFile(file) { return this.#fileHub.share(file); }

  /** The small viewable rendition of a shared image, or null (see room-files.js). */
  previewBlob(env) { return this.#fileHub.previewBlob(env); }

  /** Fetch a shared file directly from its author. Resolves to a Blob. */
  downloadFile(env, onProgress) { return this.#fileHub.download(env, onProgress); }

  /** Join requests waiting for the owner (see owner-desk.js). */
  get joinRequests() { return this.#desk.requests; }
  approveJoin(id) { return this.#desk.approveJoin(id); }
  declineJoin(id) { return this.#desk.declineJoin(id); }
  removeMember(id) { return this.#desk.removeMember(id); }
  newRecoveryCode() { return this.#desk.newRecoveryCode(); }
  beginRecovery(seed) { return this.#desk.beginRecovery(seed); }
  get recovering() { return this.#desk.recovering; }
  transferOwnership(id) { return this.#desk.transferOwnership(id); }

  /** Pairing by codes, no server needed (see pairing.js): 1. inviter, 2. invitee, 3. inviter. */
  createInvite() { return this.#pairing.createInvite(); }
  answerOffer(offer) { return this.#pairing.answerOffer(offer); }
  acceptAnswer(answer) { return this.#pairing.acceptAnswer(answer); }

  // ---- lifecycle -------------------------------------------------------------------

  start() {
    if (this.removed || !this.settings.brokersEnabled || !this.settings.brokers.length) return;
    this.#openChannel();
    this.#every(this.settings.presenceIntervalMs, () => this.#announce());
    this.#desk.sync().catch(() => {});
  }

  #openChannel() {
    this.#channel = new RoomChannel({
      roomId: this.#chan.id, aes: this.#chan.aes, selfId: this.identity.id, WS: this.WS,
      brokers: this.settings.brokers, topicPrefix: this.settings.topicPrefix, health: this.health,
    });
    this.#channel.on('presence', (p) => this.#onPresence(p));
    this.#channel.on('signal', (bytes) => this.#pairing.onSignal(bytes));
    this.#channel.on('relay', (bytes) => this.#onRelay(bytes));
    this.#channel.on(
      'status',
      (s) => { this.brokerStatus = s; this.emit('brokers', s); if (s.connected) this.#announce(); },
    );
    this.#channel.start();
  }

  // ---- key rotation ----------------------------------------------------------------------------

  /** Switch to the keys of rotation `n`. Whoever left (or lost the secret) cannot follow:
   *  the broker topic, presence, signalling and relay all move to a channel only members know. */
  async #applyEpoch(n, secret) {
    this.#epoch = { n, secret };
    await this.#kv.put(`epoch:${this.id}`, { n, s: toB64u(secret) });
    this.#chan = await deriveRoomKeys(this.#chanSecret());
    this.members.clear(); // presence under the old keys means nothing now
    if (this.#channel) { this.#channel.stop(); this.#openChannel(); }
    await this.#desk.restart(); // old join links stop working
    this.#emitPeers();
    this.emit('roster');
  }

  /** Members hand the rotation secret on over their authenticated links, never over brokers. */
  #sendEpoch(link) {
    if (this.#epoch.n) {
      const { n, secret } = this.#epoch;
      link.sendChat(JSON.stringify({ t: 'epoch', n, s: toB64u(secret) }));
    }
  }

  #shareEpoch(exceptId) {
    for (const p of this.peers.values()) {
      if (p.state === 'p2p' && p.synced && p.id !== exceptId) this.#sendEpoch(p.link);
    }
  }

  async #onEpoch(m, entry) {
    const want = this.roster?.epoch; // what the owner announced in the chain
    if (!want?.commit || m.n !== want.n || m.n <= this.#epoch.n || typeof m.s !== 'string') return;
    let secret;
    try { secret = fromB64u(m.s); } catch { return; }
    if (toB64u(await sha256(secret)) !== want.commit) return; // not the owner's secret
    await this.#applyEpoch(m.n, secret);
    this.#shareEpoch(entry.id);
  }

  stop() {
    for (const t of this.#timers) { clearInterval(t); clearTimeout(t); }
    this.call.leave();
    this.#channel?.stop();
    this.#desk.stop();
    this.#pairing.stop();
    for (const { link } of this.peers.values()) link.close();
  }

  #every(ms, fn) { const t = setInterval(fn, ms); t.unref?.(); this.#timers.add(t); }

  // ---- sending ------------------------------------------------------------------------

  /** `quote`: an envelope this message answers (shown above the text, like a reply). */
  async sendText(text, quote = null) {
    text = text.trim();
    if (!text) return null;
    if (text.length > this.settings.maxTextLength) throw new Error('Message too long');
    if (!quote) return this.#publish('text', text);
    const shown = quote.kind === 'file' ? null : this.log.textOf(quote); // quote the edited text
    return this.#publish('reply', replyBody(text, quoteOf(quote, shown)));
  }

  /** Recall a message: everyone drops its content and sees who deleted it. Its author may,
   *  and so may the room owner. */
  async deleteMessage(id) {
    if (this.log.isGone(id) || this.log.get(id)?.kind === 'del') return null;
    if (!this.isMine(authorOfId(id)) && !this.isOwner) {
      throw new Error('You can only delete your own messages');
    }
    return this.#publish('del', delBody(id));
  }

  /** Change the text of one of our own messages. Everyone sees the new text, marked as edited. */
  async editMessage(id, text) {
    text = text.trim();
    if (!text) throw new Error('A message cannot be empty');
    if (text.length > this.settings.maxTextLength) throw new Error('Message too long');
    const env = this.log.get(id);
    if (!['text', 'reply'].includes(env?.kind)) throw new Error('That message cannot be edited');
    if (!this.isMine(authorIdOf(env))) {
      throw new Error('You can only edit your own messages');
    }
    if (text === this.log.textOf(env)) return null;
    return this.#publish('edit', editBody(id, text));
  }

  /** Switch our reaction `emoji` on message `id` on or off. */
  async react(id, emoji) {
    if (!isEmoji(emoji)) throw new Error('Not an emoji');
    if (!this.log.get(id)) throw new Error('That message is gone');
    const mine = this.log.overlay().reactions.get(id)?.get(emoji)?.some((who) => this.isMine(who));
    return this.#publish('react', reactBody(id, emoji, !mine));
  }






  async #publish(kind, body, signer = this.identity) {
    if (this.removed) throw new Error('You were removed from this room');
    if (this.#isUnlinked(signer.cert, signer.member)) throw new Error('This device was unlinked');
    const env = await createEnvelope(signer, this.hlc, this.id, kind, body, this.#name);
    const kept = await this.#accept(env, null);
    if (!kept && ADMIN_KINDS.includes(kind)) throw new Error('That change could not be applied');
    this.#sendToPeers(env);
    if (this.#needsRelay()) this.#channel.sendRelay(utf8.encode(JSON.stringify(env)));
    return env;
  }

  /** Deliver a call frame to one member over its direct link. False if there is none. */
  #sendCall(id, frame) {
    const p = this.peers.get(id);
    if (p?.state !== 'p2p' || !p.synced) return false;
    try { p.link.sendChat(JSON.stringify({ t: 'call', ...frame })); } catch { return false; }
    return true;
  }

  #sendToPeers(env, exceptId = null) {
    const frame = JSON.stringify({ t: 'msg', e: env });
    for (const p of this.peers.values()) {
      if (p.state === 'p2p' && p.synced && p.id !== exceptId) {
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
    if (this.#isUnlinked(env.cert, authorIdOf(env))) return false;
    if (!this.#permits(env)) return false;
    return this.#accept(env, source);
  }

  // ---- linked devices ---------------------------------------------------------------------

  #isUnlinked(cert, memberId) { return !!cert && this.#unlinked.has(`${memberId}|${cert.d}`); }

  #noteUnlink(env) { this.#unlinked.add(`${authorIdOf(env)}|${env.body.d}`); }

  /** Main device: withdraw the certificate of a linked device (its public key, base64url) in
   *  this room. Everyone drops its links and refuses what it writes from then on. */
  async unlinkDevice(devicePub) {
    if (this.identity.cert) throw new Error('Only the main device can unlink a device');
    return this.#publish('unlink', unlinkBody(devicePub));
  }

  /** A certificate was withdrawn: close that device's links; if it was ours, say so. */
  #onUnlink(env) {
    this.#noteUnlink(env);
    for (const entry of this.peers.values()) {
      const theirs = (entry.member ?? entry.id) === authorIdOf(env);
      if (!theirs || !entry.pub || toB64u(entry.pub) !== env.body.d) continue;
      const timer = setTimeout(() => entry.link.close(), 300); // the news travels on first
      timer.unref?.();
    }
    if (this.#isUnlinked(this.identity.cert, this.identity.member)) this.emit('unlinked');
  }

  /** A linked device introduces itself on a new link: the certificate must be for exactly
   *  the key this link was authenticated with. */
  async #onCert(entry, { cert }) {
    const member = await verifyCert(cert);
    if (!member || !entry.pub || cert.d !== toB64u(entry.pub)) return;
    if (this.#isUnlinked(cert, member) || this.roster?.revoked.has(member)) {
      entry.link.close();
      return;
    }
    entry.member = member;
    if (this.roster && !entry.synced && this.roster.isMember(member)) this.#markSynced(entry);
    this.#emitPeers();
  }

  #sendCert(link) {
    if (this.identity.cert) link.sendChat(JSON.stringify({ t: 'cert', cert: this.identity.cert }));
  }

  /** Who may post what. Admin envelopes are checked by the roster itself. */
  #permits(env) {
    const author = authorIdOf(env);
    const owner = this.roster?.owner;
    if (env.kind === 'del' && authorOfId(env.body.id) !== author && author !== owner) return false;
    if (env.kind === 'edit' && authorOfId(env.body.id) !== author) return false; // own only
    if (!this.roster) return !ADMIN_KINDS.includes(env.kind); // open rooms have no admin
    return ADMIN_KINDS.includes(env.kind) || this.roster.isMember(author);
  }

  async #accept(env, source) {
    const batch = this.roster && ADMIN_KINDS.includes(env.kind) ? this.roster.apply(env) : [env];
    let kept = false;
    for (const e of batch) {
      const done = await this.#keep(e, source);
      if (e === env) kept = done;
    }
    return kept;
  }

  /** Older edits / reactions that `env` replaces; null if a newer one is already here. For one
   *  message only the latest edit counts, and per author and emoji only the latest reaction. */
  #superseded(env) {
    if (!DECORATIONS.includes(env.kind)) return [];
    const author = authorIdOf(env);
    const sameSlot = (e) => e.kind === env.kind && e.body.id === env.body.id && (
      env.kind === 'edit' || (authorIdOf(e) === author && e.body.emoji === env.body.emoji));
    const older = this.log.where(sameSlot);
    return older.some((e) => byStamp(e, env) > 0) ? null : older;
  }

  /** Edits and reactions riding on message `id`. */
  #decorations(id) {
    return this.log.where((e) => DECORATIONS.includes(e.kind) && e.body.id === id);
  }

  async #keep(env, source) {
    // nothing may ride on a deleted message (an edit would bring its text back)
    if (DECORATIONS.includes(env.kind) && this.log.isGone(env.body.id)) return false;
    const stale = this.#superseded(env);
    if (!stale) return false;
    const doomed = env.kind === 'del' ? this.log.get(env.body.id) : null;
    const orphans = env.kind === 'del' ? this.#decorations(env.body.id) : [];
    if (!this.log.add(env)) return false;
    this.log.drop([...stale, ...orphans]);
    this.hlc.observe(env);
    const removed = this.log.trim();
    const dropped = [...removed, ...stale, ...orphans, ...(doomed ? [doomed] : [])];
    await Promise.all([this.#store.save(env), this.#store.remove(dropped)])
      .catch((err) => console.error('could not save message', err));
    if (doomed) await this.#forget(doomed);
    if (ADMIN_KINDS.includes(env.kind)) await this.#onAdmin(env);
    if (env.kind === 'unlink') this.#onUnlink(env);
    const fresh = this.#marks.isUnread(env); // decided before a viewer can mark it read
    // Membership changes are shown in the conversation too ("Bob joined"): redraw for them.
    if (env.kind !== 'recovery' && !removed.includes(env)) this.emit('message', env);
    if (fresh && !removed.includes(env)) { this.emit('incoming', env); this.emit('unread'); }
    if (source) this.#sendToPeers(env, source.id); // gossip: heals meshes with a missing link
    return true;
  }

  /** A membership change took effect. */
  async #onAdmin(env) {
    const { kind, body } = env;
    if (kind === 'revoke') {
      if (this.isMine(body.id)) return this.#beRemoved();
      this.members.delete(body.id);
      this.call.peerDown(body.id);
      this.#desk.dropRequest(body.id);
      for (const peer of [...this.peers.values()]) {
        if ((peer.member ?? peer.id) !== body.id) continue;
        // tell them first, so their app can say so, then drop the link
        try { peer.link.sendChat(JSON.stringify({ t: 'admin', es: [env] })); } catch { /* gone */ }
        const timer = setTimeout(() => peer.link.close(), 300);
        timer.unref?.();
      }
    }
    if (kind === 'recover' && this.roster.revoked.has(this.identity.member)) {
      return this.#beRemoved();
    }
    if (kind === 'transfer' || kind === 'recover') await this.#desk.sync();
    this.#emitPeers();
    this.emit('roster');
    await this.#desk.tryRecover();
    return undefined;
  }

  #beRemoved() {
    this.removed = true;
    this.stop();
    this.emit('removed');
    this.emit('roster');
  }

  /** A deleted file message: stop offering it and drop every cached copy of its preview. */
  async #forget(env) {
    if (env.kind !== 'file') return;
    const ids = [env.body.id, env.body.img?.p?.id].filter(Boolean);
    this.files.forget(...ids);
    await Promise.all(ids.map((id) => this.previews.delete(id).catch(() => {})));
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
    if (m?.t === 'cert') { await this.#onCert(entry, m); return; }
    if (this.roster && m?.t === 'admin' && Array.isArray(m.es)) {
      for (const e of m.es.slice(0, 100)) await this.#ingest(e, null);
      if (!entry.synced && this.roster.isMember(entry.member ?? entry.id)) this.#markSynced(entry);
      return;
    }
    if (this.roster && !entry.synced) return; // not (yet) known to be a member: ignored
    if (this.roster && m?.t === 'epoch') { await this.#onEpoch(m, entry); return; }
    if (m?.t === 'call') { this.call.onFrame(entry.id, m); return; }
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

  /** Membership comes first: both sides send their admin chain, and only talk chat once the
   *  other side is a known member. */
  #sendAdmin(link) {
    const envs = this.roster.envs();
    let [from, size] = [0, 0];
    for (let at = 0; at < envs.length; at++) {
      const n = JSON.stringify(envs[at]).length;
      if (size + n > MAX_FRAME_BYTES && at > from) {
        link.sendChat(JSON.stringify({ t: 'admin', es: envs.slice(from, at) }));
        [from, size] = [at, 0];
      }
      size += n;
    }
    if (from < envs.length) link.sendChat(JSON.stringify({ t: 'admin', es: envs.slice(from) }));
  }

  #markSynced(entry) {
    entry.synced = true;
    this.call.peerUp(entry.id);
    this.#sendEpoch(entry.link);
    this.#sendHave(entry.link);
    this.#emitPeers();
  }

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
      synced: false,
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
      this.#sendCert(link);
      if (!this.roster) {
        entry.synced = true;
        this.call.peerUp(peer.id);
        this.#sendHave(link);
      } else {
        this.#sendAdmin(link);
        if (this.roster.isMember(peer.id)) this.#markSynced(entry);
        const wait = setTimeout(() => !entry.synced && link.close(), this.settings.adminTimeoutMs);
        wait.unref?.();
      }
      this.#announce();
    });
    entry.queue = Promise.resolve(); // frames of one link are handled one after the other
    link.on('chat', (raw) => {
      entry.queue = entry.queue.then(() => this.#onChat(entry, raw))
        .catch((err) => console.error('chat frame failed', err));
    });
    link.on('file', (data) => this.files.onFrame(link, data));
    link.on('close', () => {
      clearTimeout(timer);
      if (this.peers.get(peer.id) !== entry) return;
      this.peers.delete(peer.id);
      this.call.peerDown(peer.id);
      this.#emitPeers();
      this.#announce();
    });
    this.#emitPeers();
    return entry;
  }

  #emitPeers() { this.emit('peers', this.peerList); }








  // ---- owner: members and join requests ------------------------------------------------------


  /** Everyone in the room (owner first), for the members list. */
  membersView() {
    if (!this.roster) return [];
    const live = new Map(this.peerList.map((p) => [p.member, p.state]));
    return [this.roster.owner, ...this.roster.members.keys()].map((id) => ({
      id, name: this.#nameOf(id), owner: id === this.roster.owner, self: this.isMine(id),
      state: this.isMine(id) ? 'self' : live.get(id) ?? 'offline',
    }));
  }

  /** A readable name for someone in this room, even after they left. */
  nameOf(id) { return this.#nameOf(id); }

  #nameOf(id) {
    if (id === this.identity.id || id === this.identity.member) return this.#name;
    const seen = this.peers.get(id)?.name ?? this.members.get(id)?.name
      ?? this.roster?.names.get(id);
    if (seen) return seen;
    const env = this.log.list().findLast((e) => authorIdOf(e) === id);
    return env?.name ?? id.slice(0, 4);
  }

  /** What a join link needs: the lobby secret (cannot read the room) and the owner's id.
   *  Anyone in the room may hand it out; the owner still decides about every request. */
  async joinLinkParts() {
    if (!this.roster) return null;
    return { lobbySecret: await lobbySecretOf(this.#chanSecret()), ownerId: this.roster.owner };
  }





  // ---- recovery: taking the room back after the owner's identity is lost -----------------------






  /** Feed an owner-signed envelope (the approval that came with the grant). */
  receiveAdmin(env) { return this.#ingest(env, null); }





  // ---- automatic pairing through brokers
  // --------------------------------------------------------------------

  #announce() { this.#channel?.announce({ pub: this.identity.pub, name: this.#name }); }

  async #onPresence({ id, pub, name }) {
    if (this.roster?.revoked.has(id)) return;
    const isNew = !this.members.has(id);
    this.members.set(id, { pub, name, seen: Date.now() });
    if (isNew) { this.#emitPeers(); this.#announceSoon(); }
    const state = this.peers.get(id)?.state;
    // Glare rule: the peer with the smaller id always makes the offer.
    if (!state && this.identity.id < id) await this.#pairing.dial({ id, pub, name });
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


}
