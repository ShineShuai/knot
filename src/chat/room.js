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
// Events: 'message'(envelope), 'peers'(list), 'brokers'({connected,total} | null),
//         'roster'(), 'requests'() (owner: join requests changed), 'removed'(),
//         'incoming'(envelope) (a message from someone else that is not read yet),
//         'unread'() (the unread count changed), 'read'(stamp) (we read further: see ReadMarks),
//         'sibling'(peer) (a device of ours is connected), 'sync'(items, peer, epochs)
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
  ADMIN_KINDS, authorIdOf, authorOfId, createEnvelope, delBody, editBody, isAlias, isEmoji, quoteOf,
  reactBody, replyBody, unlinkBody, verifyEnvelope,
} from './envelope.js';
import { MessageLog, byStamp } from './log.js';
import { MessageStore } from './message-store.js';
import { POLICY, Policy, policyBody, validPolicyBody } from './policy.js';
import { JoinRequest } from './join.js';
import { OwnerDesk } from './owner-desk.js';
import { Pairing } from './pairing.js';
import { ReadMarks } from './read-marks.js';
import { RoomFiles } from './room-files.js';
import { Roster } from './roster.js';
import { PROTOCOL, VERSION } from '../version.js';
import { lobbySecretOf } from './lobby.js';

const MAX_FRAME_BYTES = 48 * 1024; // keep chat frames well under every browser's SCTP limit
const DECORATIONS = ['edit', 'react']; // envelopes that ride on another message
const ACK_KINDS = ['text', 'reply', 'file']; // what a receiver confirms and a sender waits for
const ACK_DELAY_MS = 250; // confirmations are sent in groups
const ACK_RETRY_MS = [5000, 20_000, 60_000, 180_000]; // when still unconfirmed: try the brokers
const ACK_DUP_MS = 5 * 60_000; // a repeated message is confirmed again if it is this recent
const ACK_TRACKED = 500; // own messages whose delivery is followed
const PENDING_MAX = 200; // messages kept while their author's admission is unknown
const PENDING_TTL_MS = 10 * 60 * 1000;
const KNOCK_AGAIN_MS = 5 * 60_000; // how often a member who is not on the list asks to be let in
const CHAIN_ASK_MS = 5000; // at most one question for the member list this often
const ANSWER_QUIET_MS = 1500; // a relayed answer was heard: do not repeat it
const RELAY_HAVE_IDS = 40; // ids in a `have` over the brokers (they carry less than a link does)
const RELAY_GIVE_MAX = 100;
const RELAY_SYNC_MS = 60_000;
const LINKED_COUNTER_BASE = 500_000;

export class Room extends Emitter {
  /** peerId -> { id, pub, name, link, via:'broker'|'manual', state:'connecting'|'p2p', sas } */
  peers = new Map();
  /** peerId -> { pub, name, seen } for everyone announcing on the brokers */
  members = new Map();

  #chan; #store; #kv; #channel = null; #timers = new Set();
  // Messages that passed every check but one: their author is not (yet) in our copy of the member
  // list. They wait here for the list to catch up, instead of being lost.
  #pending = new Map(); // envelope id -> { env, at }
  #dismissed = new Set(); // authors the owner chose to ignore (until the page restarts)
  #chainAskedAt = 0; #adminHeardAt = 0; #giveSentAt = 0;
  // Delivery: our own message id -> members who confirmed it; and the confirmations we owe.
  #acks = new Map();
  #ackQueue = new Map(); // author member id -> Set of message ids
  #ackTimer = null;
  /** Why messages were refused, for the diagnostics: reason -> { n, last: { at, by, name } }. */
  dropped = {};
  #epoch = { n: 0, secret: null }; // key rotations: the channel keys depend on it
  #fileHub; #marks; #desk; #pairing; // what the room delegates, see the constructor
  #unlinked = new Set();     // "<member id>|<device key>" of every withdrawn certificate
  #multi = new Set();        // members seen with a certificate: they use more than one device

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
    /** This person's own choices for the room (the model keeps them: AppModel.setRoomPrefs). */
    this.prefs = {};
    /** What the owner decided for the whole room (see policy.js); the defaults in an open room. */
    this.policy = new Policy();
    this.id = keys.id; // the room's identity: signatures, storage; never changes
    this.#chan = { id: keys.id, aes: keys.aes }; // where we meet on the brokers: can rotate
    this.#kv = kv;
    // A linked device writes as the main identity: its counters start high, so their ids
    // cannot collide with the main device's.
    this.hlc = new HLC(Date.now, identity.cert ? LINKED_COUNTER_BASE : 0);
    if (identity.cert || identity.alias) this.#multi.add(identity.member);
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
      send: (id, frame) => this.#sendCall(id, frame), allowed: () => this.policy.rules.calls,
      ...callEnv,
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
    this.#marks.on('read', (stamp) => this.emit('read', stamp));
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
    const rows = [...this.peers.values()].map((p) => {
      const seen = this.members.get(p.id); // what its presence said, before any link was up
      const who = p.member ?? seen?.member ?? p.id;
      return {
        id: p.id, name: p.name, via: p.via, sas: p.sas, member: who, owner: owner(who),
        mod: !!this.roster?.isMod(who), synced: p.synced,
        mine: who === this.identity.member,
        device: this.deviceOf(who, p.alias ?? seen?.alias ?? p.device ?? seen?.device),
        state: p.state === 'p2p' || !viaRelay(p.id) ? p.state : 'relay',
        limited: p.limited ?? 0,
      };
    });
    for (const [id, m] of this.members) {
      if (!this.peers.has(id) && this.#isFresh(m)) rows.push({
        id, name: m.name, state: viaRelay(id) ? 'relay' : 'seen', via: 'broker', sas: null,
        member: m.member ?? id, owner: owner(m.member ?? id),
        mod: !!this.roster?.isMod(m.member ?? id),
        mine: (m.member ?? id) === this.identity.member,
        device: this.deviceOf(m.member ?? id, m.alias ?? m.device),
      });
    }
    return rows;
  }

  async #load() {
    const stored = await this.#store.loadAll();
    for (const env of stored) { this.log.add(env); this.hlc.observe(env); this.#noteDevice(env); }
    const trimmed = this.log.trim();
    const deleted = stored.filter((e) => !this.log.get(e.id) && !trimmed.includes(e));
    await this.#store.remove([...trimmed, ...deleted]); // deleted messages leave no content
    // An older version of the app may have saved this room without its owner. If our own
    // signature starts its membership chain, the room is ours: nobody can fake that.
    const ours = (e) => ADMIN_KINDS.includes(e.kind) && e.body.prev === ''
      && authorIdOf(e) === this.identity.member;
    if (!this.roster && stored.some(ours)) this.roster = new Roster(this.identity.member);
    this.roster?.load(stored);
    if (this.roster) { // the rules were checked when they came in; take the newest we kept
      for (const env of stored.filter((e) => e.kind === POLICY)) {
        if (this.policy.supersedes(env)) this.policy.set(env);
      }
    }
    // Envelopes that were still waiting for an earlier link when we last ran (see #saveWaiting).
    const held = this.roster ? await this.#kv.get(`wait:${this.id}`) : null;
    if (Array.isArray(held)) this.roster.load(held);
    this.#waitingSaved = this.roster ? this.#waitingKey() : '';
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

  /** This device as a row of the connection bar. Its connection type is the best way it
   *  reaches the room, in the words used for everybody else: `p2p` (at least one direct link),
   *  `relay` (no direct link, but a broker: messages are passed on through it) or `offline`
   *  (neither). */
  get selfRow() {
    const { connected = 0 } = this.brokerStatus ?? {};
    const direct = [...this.peers.values()].some((p) => p.state === 'p2p');
    return {
      id: this.identity.id, name: this.#name, member: this.identity.member, mine: true,
      self: true, sas: null, via: 'self', owner: this.isOwner, mod: this.isMod,
      state: direct ? 'p2p' : connected > 0 ? 'relay' : 'offline',
      device: this.deviceOf(this.identity.member, this.identity.alias ?? this.identity.cert?.n),
    };
  }

  /** Which device of `authorId` is meant, for a name tag like "Ada · phone": null while only
   *  one device of that member is known; else `device` (its alias, or the name in its
   *  certificate), or '' for the main device, which has neither. */
  deviceOf(authorId, device = null) {
    return this.#multi.has(authorId) ? (device ?? '') : null;
  }

  /** The same for a live connection by its device id (this device included). */
  peerDevice(id) {
    if (id === this.identity.id) {
      return this.deviceOf(this.identity.member, this.identity.alias ?? this.identity.cert?.n);
    }
    const entry = this.peers.get(id);
    return this.deviceOf(entry?.member ?? id, entry?.alias ?? entry?.device);
  }

  #noteDevice(env) { if (env.cert || env.al) this.#multi.add(authorIdOf(env)); }




  /** What the broker channel and lobby keys derive from: the room secret, mixed with the
   *  latest rotation's secret once a member has been removed. */
  #chanSecret(epoch = this.#epoch) {
    return epoch.n ? concat(this.secret, epoch.secret) : this.secret;
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

  get isOwner() { return !!this.roster && this.roster.owner === this.identity.member; }

  /** A moderator: the owner trusts them to let people in and to delete what others wrote. */
  get isMod() { return !!this.roster && this.roster.isMod(this.identity.member); }

  /** The owner or a moderator. */
  get isStaff() { return this.isOwner || this.isMod; }

  /** The owner's name, as we know it (null in a room without an owner). */
  get ownerName() { return this.roster ? this.#nameOf(this.roster.owner) : null; }

  /** Is the owner (any device) here: connected, or announcing on the brokers? */
  get ownerOnline() {
    if (!this.roster || this.isOwner) return !!this.roster;
    const { owner } = this.roster;
    const direct = [...this.peers.values()].some(
      (p) => p.state === 'p2p' && (p.member ?? p.id) === owner,
    );
    return direct || [...this.members].some(
      ([id, m]) => (m.member ?? id) === owner && this.#isFresh(m),
    );
  }

  /** Our own admission is missing from our copy of the member list (and has been for a while):
   *  others refuse what we write until it arrives, from the owner or a member who has it. */
  get unadmitted() {
    return !!this.roster && !this.removed && !this.roster.isMember(this.identity.member)
      && Date.now() - this.#openedAt > this.settings.adminTimeoutMs;
  }
  #openedAt = Date.now();
  get ownerId() { return this.roster?.owner ?? null; }

  /** Connection details of everyone we know, for the hold-V reveal:
   *  { id, name, state, via, net: { local, remote, protocol, rtt } | null } */
  async connectionInfo() {
    return Promise.all(this.peerList.map(async ({ id, name, state, via, device, mine }) => {
      const link = this.peers.get(id)?.link;
      const net = state === 'p2p' ? await link?.stats?.().catch(() => null) ?? null : null;
      return { id, name, state, via, net, device, mine };
    }));
  }

  // ---- what the room delegates (see the constructor) ----------------------------------------

  /** Image previews here: the person's choice for this room, else the app-wide setting. */
  get previewMode() { return this.prefs.previews ?? this.settings.imagePreviews; }

  /** No notifications, and not counted in the tab title or the app's badge. */
  get muted() { return this.prefs.mute === true; }

  /** Messages from others that this device has not shown to its user yet. */
  get unread() { return this.#marks.count; }

  /** The user has seen everything up to now (they are looking at this room). */
  markRead() { return this.#marks.markRead(); }
  /** How far this room has been read (a message stamp), here or on another device of ours. */
  get readStamp() { return this.#marks.stamp; }
  /** Another device of ours has read up to `stamp`. */
  advanceRead(stamp) { return this.#marks.advance(stamp); }

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
  /** Owner only: make a member a moderator, or an ordinary member again. */
  makeModerator(id) { return this.#desk.setRole(id, 'mod'); }
  removeModerator(id) { return this.#desk.setRole(id, 'member'); }
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
    // a new member's list needs a moment to arrive: then the notes about it may show
    if (this.roster) {
      this.#after(this.settings.adminTimeoutMs, () => {
        this.#emitPeers();
        this.#knockAgain();
        this.#reassertRules();
      });
    }
    if (this.removed || !this.#brokersOn()) return;
    this.#openChannel();
    this.#announceEvery();
    this.#desk.sync().catch(() => {});
  }

  #brokersOn() { return this.settings.brokersEnabled && this.settings.brokers.length > 0; }

  #announcing = false;
  #announceEvery() {
    if (this.#announcing) return;
    this.#announcing = true;
    this.#every(this.settings.presenceIntervalMs, () => this.#announce());
    // Messages and the member list that only the brokers can bring are asked for now and then.
    this.#every(KNOCK_AGAIN_MS, () => this.#knockAgain());
    this.#every(RELAY_SYNC_MS, () => {
      if (this.#needsRelay()) this.#relaySync();
      else if (this.roster?.gap) this.#needChain(); // a link of the member list is missing
    });
  }

  #relaySyncQueued = false;
  #relaySyncSoon(ms = 500 + Math.random() * 1000) {
    if (this.#relaySyncQueued) return;
    this.#relaySyncQueued = true;
    this.#after(ms, () => { this.#relaySyncQueued = false; this.#relaySync(); });
  }

  /** The brokers, or the switch for them, changed in Settings: apply it to the running room. */
  async refreshBrokers() {
    if (this.removed) return;
    this.#channel?.stop();
    this.#channel = null;
    if (this.#brokersOn()) {
      this.#openChannel();
      this.#announceEvery();
    } else this.brokerStatus = null;
    this.emit('brokers', this.brokerStatus);
    await this.#desk.restart();
  }

  /** The page came back from the background, or the network did: sockets and links may have
   *  died without a sound. Reach the brokers again at once and compare histories on every link. */
  wake() {
    if (this.removed) return;
    this.#channel?.wake();
    this.#relaySyncSoon(2000); // once the brokers are reached again
    for (const p of this.peers.values()) {
      if (p.state !== 'p2p' || !p.synced) continue;
      try { this.#sendHave(p.link); } catch { /* the link is dying */ }
    }
  }

  #openChannel() {
    const channel = new RoomChannel({
      roomId: this.#chan.id, aes: this.#chan.aes, selfId: this.identity.id, WS: this.WS,
      brokers: this.settings.brokers, topicPrefix: this.settings.topicPrefix, health: this.health,
    });
    this.#channel = channel;
    // A channel that was replaced (new keys, new brokers) may still say its last words: ignore.
    const current = (fn) => (...args) => { if (this.#channel === channel) fn(...args); };
    channel.on('presence', current((p) => this.#onPresence(p)));
    channel.on('signal', current((bytes) => this.#pairing.onSignal(bytes)));
    channel.on('relay', current((bytes) => this.#onRelay(bytes)));
    channel.on('status', current((s) => {
      this.brokerStatus = s;
      this.emit('brokers', s);
      if (s.connected) { this.#announce(); this.#relaySyncSoon(); }
    }));
    channel.start();
  }

  // ---- not on the list: ask the owner to let us in again ---------------------------------------

  #knock = null; #declined = false;

  /** This device holds the room but its own identity is not on the member list: typically it
   *  started over with a new identity (a device that left its main device keeps its rooms), or
   *  its admission was lost. Others refuse everything it writes, and nothing says so. Ask the
   *  owner, as a join link would: they see a request and decide (a new identity is never let in
   *  without them). Only while the owner is online, and not again once they declined. */
  async #knockAgain() {
    if (this.#knock || this.#declined || this.isOwner || !this.unadmitted) return;
    if (!this.#brokersOn() || !this.ownerOnline) return;
    const { lobbySecret, ownerId } = await this.joinLinkParts();
    const ask = new JoinRequest({
      identity: this.identity, lobbySecret, ownerId, name: this.#name, greeting: 'rejoining',
      settings: this.settings, WS: this.WS,
    });
    this.#knock = ask;
    ask.on('approved', (grant) => this.#letIn(grant));
    ask.on('status', (status) => {
      if (!['declined', 'timeout', 'offline'].includes(status)) return;
      this.#declined = status === 'declined';
      this.#knock = null;
      this.#emitPeers();
    });
    await ask.start();
    this.#emitPeers();
  }

  /** The owner let us in again: take the member list (and a key rotation we missed) they sent. */
  async #letIn({ secret, admit, chain, epoch }) {
    this.#knock = null;
    if (this.removed || toB64u(secret) !== toB64u(this.secret)) return;
    for (const env of Array.isArray(chain) ? chain.slice(0, 200) : []) {
      await this.#ingest(env, null).catch(() => {});
    }
    if (admit) await this.#ingest(admit, null).catch(() => {});
    if (epoch?.n > this.#epoch.n && typeof epoch.s === 'string') {
      await this.#applyEpoch(epoch.n, fromB64u(epoch.s)).catch(() => {});
    }
    this.#emitPeers();
  }

  /** Have we asked the owner to let us in, and are waiting for the answer? */
  get knocking() { return !!this.#knock; }

  // ---- key rotation ----------------------------------------------------------------------------

  /** Switch to the keys of rotation `n`. Whoever left (or lost the secret) cannot follow:
   *  the broker topic, presence, signalling and relay all move to a channel only members know. */
  async #applyEpoch(n, secret) {
    const next = { n, secret };
    // The new channel keys first, so that `epoch` and `channelId` always change together.
    const chan = await deriveRoomKeys(this.#chanSecret(next));
    [this.#epoch, this.#chan] = [next, chan];
    await this.#kv.put(`epoch:${this.id}`, { n, s: toB64u(secret) });
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
    this.#knock?.stop();
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
    if (!this.isMine(authorOfId(id)) && !this.isStaff) {
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

  // ---- the room's rules (see policy.js) ----------------------------------------------------

  /** The rules in force (see DEFAULT_RULES). */
  get rules() { return this.policy.rules; }

  /** The name to show: the person's own, else the one the owner gave everyone, else the first. */
  get title() { return this.prefs.name || this.policy.rules.name || this.label; }

  /** The largest file this room takes: the person's own limit, or the room's if that is lower. */
  get fileLimit() {
    const { maxFileMb } = this.policy.rules;
    const limit = this.settings.maxFileBytes;
    return maxFileMb ? Math.min(limit, maxFileMb * 1024 * 1024) : limit;
  }

  /** May this person delete `env`? Its author may; the owner too, unless the room says not. */
  mayDelete(env) {
    return this.isMine(authorIdOf(env)) || (this.isStaff && this.policy.rules.ownerDelete);
  }

  /** Owner only: change the rules (those not given stay as they are). Returns the envelope, or
   *  null if nothing changes. */
  async setRules(rules) {
    if (!this.isOwner) throw new Error('Only the room owner can do this');
    const next = { ...this.policy.rules, ...rules };
    if (!validPolicyBody({ rev: 1, rules: next })) throw new Error('Those rules are not valid');
    if (Object.keys(next).every((key) => next[key] === this.policy.rules[key])) return null;
    return this.#publish(POLICY, policyBody(this.policy.rev + 1, next));
  }

  /** Refuse what the rules forbid before it is signed, with the reason (the screen already shows
   *  it, by not offering the action). Open rooms have no rules. */
  #checkRules(kind, body) {
    if (!this.roster) return;
    const target = kind === 'del' ? authorOfId(body.id) : null;
    const why = this.policy.denies(kind, this.identity.member, this.roster.owner,
      { size: body?.size, target, staff: this.isStaff });
    if (why === 'files') throw new Error('Sharing files is turned off in this room');
    if (why === 'size') {
      throw new Error(`Files in this room are limited to ${this.rules.maxFileMb} MB`);
    }
    if (why === 'post') throw new Error('Only the room owner can write here');
    if (why === 'delete') throw new Error('The owner cannot delete what others wrote in this room');
  }

  /** The rules changed (here or by the owner): lobby and calls follow, and the screen. */
  async #onPolicy() {
    if (!this.policy.rules.calls && this.call.joined) this.call.leave();
    await this.#desk.sync(); // a closed room stops answering join requests, an open one starts
    this.emit('policy');
  }

  /** A new owner signs the rules they took over again: only the current owner's envelope is
   *  accepted, so members who join later would otherwise get the old owner's and drop it. */
  async #reassertRules() {
    const held = this.policy.env;
    if (!this.isOwner || !this.policy.custom || !held || this.isMine(authorIdOf(held))) return;
    await this.#publish(POLICY, policyBody(this.policy.rev + 1, this.policy.rules))
      .catch(() => {});
  }






  async #publish(kind, body, signer = this.identity) {
    if (this.removed) throw new Error('You were removed from this room');
    this.#checkRules(kind, body);
    if (this.#isUnlinked(signer.cert, signer.member)) throw new Error('This device was unlinked');
    const env = await createEnvelope(signer, this.hlc, this.id, kind, body, this.#name);
    const kept = await this.#accept(env, null);
    if (!kept && ADMIN_KINDS.includes(kind)) throw new Error('That change could not be applied');
    this.#sendToPeers(env);
    if (this.#needsRelay()) this.#channel.sendRelay(utf8.encode(JSON.stringify(env)));
    if (ACK_KINDS.includes(kind)) this.#expectAck(env);
    return env;
  }

  // ---- delivery: who has it? --------------------------------------------------------------

  /** How many other members confirmed our message `id` (null: not followed, e.g. an old one). */
  deliveredTo(id) { return this.#acks.get(id)?.size ?? null; }

  /** Follow our message: if nobody confirms it, send it again through the brokers (a link can
   *  look open and carry nothing), a few times. Later, `have`/`give` is the net underneath. */
  #expectAck(env) {
    this.#acks.set(env.id, new Set());
    if (this.#acks.size > ACK_TRACKED) this.#acks.delete(this.#acks.keys().next().value);
    const scale = this.settings.ackRetryScale ?? 1; // (tests)
    const again = (attempt) => {
      if (attempt >= ACK_RETRY_MS.length) return;
      this.#after(ACK_RETRY_MS[attempt] * scale, () => {
        if (this.#acks.get(env.id)?.size !== 0) return; // confirmed, or no longer followed
        if (this.#othersAround()) this.#resend(env);
        again(attempt + 1);
      });
    };
    again(0);
  }

  /** Is anyone but our own devices here to confirm? (Alone, there is nobody to wait for.) */
  #othersAround() {
    const mine = this.identity.member;
    for (const p of this.peers.values()) {
      if (p.state === 'p2p' && p.synced && (p.member ?? p.id) !== mine) return true;
    }
    for (const [id, m] of this.members) {
      if (this.#isFresh(m) && (m.member ?? id) !== mine) return true;
    }
    return false;
  }

  #resend(env) {
    this.#sendToPeers(env);
    if (this.#channel && this.settings.relayFallback) {
      this.#channel.sendRelay(utf8.encode(JSON.stringify(env)));
    }
  }

  /** We hold message `env` of somebody else: confirm it to its author, soon, with the others. */
  #confirm(env) {
    if (!ACK_KINDS.includes(env.kind) || this.isMine(authorIdOf(env))) return;
    const author = authorIdOf(env);
    const ids = this.#ackQueue.get(author) ?? new Set();
    ids.add(env.id);
    this.#ackQueue.set(author, ids);
    this.#ackTimer ??= this.#after(ACK_DELAY_MS, () => this.#flushAcks());
  }

  #flushAcks() {
    this.#ackTimer = null;
    const queue = [...this.#ackQueue];
    this.#ackQueue.clear();
    for (const [author, ids] of queue) {
      const links = [...this.peers.values()].filter(
        (p) => p.state === 'p2p' && p.synced && (p.member ?? p.id) === author,
      );
      const all = [...ids];
      for (let at = 0; at < all.length; at += 100) {
        const frame = { t: 'ack', ids: all.slice(at, at + 100), by: this.identity.member };
        let sent = false;
        for (const p of links) {
          try { p.link.sendChat(JSON.stringify(frame)); sent = true; } catch { /* dying */ }
        }
        if (!sent) this.#channel?.sendRelay(utf8.encode(JSON.stringify({ ...frame, to: author })));
      }
    }
  }

  #onAck(member, ids) {
    if (!member || member === this.identity.member || !Array.isArray(ids)) return;
    let changed = false;
    for (const id of ids.slice(0, 100)) {
      const set = typeof id === 'string' ? this.#acks.get(id) : null;
      if (set && !set.has(member)) { set.add(member); changed = true; }
    }
    if (changed) this.emit('delivery');
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
    // A link that is open but not yet synced carries no chat (see #sendToPeers): not a path.
    const reached = (id) => {
      const p = this.peers.get(id);
      return p?.state === 'p2p' && p.synced;
    };
    return !!this.#channel && this.settings.relayFallback
      && [...this.members].some(([id, m]) => this.#isFresh(m) && !reached(id));
  }

  #isFresh(member) { return Date.now() - member.seen < 3 * this.settings.presenceIntervalMs; }

  /** Members online whose app speaks an older or newer protocol than ours (see PROTOCOL), by
   *  name, once per person. Their devices count as one; our own devices are left out. */
  get appGaps() {
    const [older, newer] = [new Map(), new Map()];
    for (const [id, m] of this.members) {
      const who = m.member ?? id;
      if (!m.pv || !this.#isFresh(m) || this.isMine(who)) continue;
      if (m.pv < PROTOCOL) older.set(who, this.#nameOf(who));
      else if (m.pv > PROTOCOL) newer.set(who, this.#nameOf(who));
    }
    return { older: [...older.values()], newer: [...newer.values()] };
  }

  // ---- receiving -------------------------------------------------------------------------

  /** `gossip`: pass a new message on to our other links (not for history, see #gossipBatch). */
  async #ingest(env, source, gossip = true) {
    if (!env?.id) return false;
    if (this.log.has(env.id)) {
      const held = this.log.get(env.id);
      if (held && Date.now() - held.ms < ACK_DUP_MS) this.#confirm(held);
      return false;
    }
    const limits = {
      maxText: this.settings.maxTextLength,
      maxFileBytes: this.settings.maxFileBytes,
    };
    if (!(await verifyEnvelope(env, this.id, limits))) return this.#drop('invalid or forged', env);
    if (this.#isUnlinked(env.cert, authorIdOf(env))) return this.#drop('device was unlinked', env);
    if (!this.#permits(env)) return this.#refuse(env);
    return this.#accept(env, source, gossip);
  }

  /** Count a refused message (the diagnostics say why a room looks empty). Always false. */
  #drop(reason, env) {
    const entry = (this.dropped[reason] ??= { n: 0, last: null });
    entry.n++;
    entry.last = { at: Date.now(), by: env ? authorIdOf(env) : null, name: env?.name ?? null };
    return false;
  }

  /** A message from someone our member list does not know may be from a member whose admission
   *  we have not seen (it travels on direct links and, now, over the brokers): keep it, ask. */
  #refuse(env) {
    const author = authorIdOf(env);
    const stranger = this.roster && !ADMIN_KINDS.includes(env.kind) && !this.#knows(author)
      && !this.roster.revoked.has(author);
    if (!stranger) {
      const removed = this.roster?.revoked.has(author);
      const rules = this.roster && this.#knows(author) && !removed;
      return this.#drop(removed ? 'author was removed' : rules ? 'against the room rules'
        : 'not allowed', env);
    }
    if (!this.#dismissed.has(author)) { this.#hold(env); this.#needChain(); }
    return this.#drop('author not in member list', env);
  }

  #hold(env) {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [id, p] of this.#pending) if (p.at < cutoff) this.#pending.delete(id);
    if (!this.#pending.has(env.id)) {
      if (this.#pending.size >= PENDING_MAX) {
        this.#pending.delete(this.#pending.keys().next().value); // the oldest
      }
      this.#pending.set(env.id, { env, at: Date.now() });
    }
    this.emit('pending', this.#pending.size);
  }

  /** How many messages wait for the member list to learn their author. */
  get pendingCount() { return this.#pending.size; }

  /** Who wrote the messages we hold because they are not on the list: { id, name, count }, with
   *  the name as they sign it (anyone who has the room's secret can sign any name). The owner can
   *  let them in, whether or not their app asks (an older one does not). */
  get waitingSenders() {
    const by = new Map();
    for (const { env } of this.#pending.values()) {
      const id = authorIdOf(env);
      if (this.#dismissed.has(id)) continue;
      const row = by.get(id) ?? { id, name: String(env.name ?? '').slice(0, 32), count: 0 };
      row.count++;
      by.set(id, row);
    }
    return [...by.values()];
  }

  /** Owner or moderator: let in someone who wrote to the room but is not on the list. */
  async admitSender(id) {
    if (!this.isStaff) throw new Error('Only the room owner or a moderator can let someone in');
    const sender = this.waitingSenders.find((s) => s.id === id);
    if (!sender) throw new Error('No messages from them are waiting');
    await this.#desk.admit(id, sender.name || id.slice(0, 6));
  }

  /** Stop holding (and listing) what this author writes. */
  dismissSender(id) {
    this.#dismissed.add(id);
    for (const [key, { env }] of this.#pending) {
      if (authorIdOf(env) === id) this.#pending.delete(key);
    }
    this.emit('pending', this.#pending.size);
  }

  #retrying = false;
  /** The member list grew: the messages that waited for it get another look. */
  async #retryPending() {
    if (this.#retrying || !this.#pending.size) return;
    this.#retrying = true;
    try {
      for (const [id, { env }] of [...this.#pending]) {
        const author = authorIdOf(env);
        if (!this.roster.isMember(author) && !this.roster.revoked.has(author)) continue;
        this.#pending.delete(id);
        await this.#ingest(env, null).catch(() => {});
      }
    } finally {
      this.#retrying = false;
      this.emit('pending', this.#pending.size);
    }
  }

  /** Ask everybody for the member list: on direct links, and over the brokers. At most one
   *  question every few seconds. */
  #needChain() {
    const now = Date.now();
    if (!this.roster || now - this.#chainAskedAt < CHAIN_ASK_MS) return;
    this.#chainAskedAt = now;
    const frame = { t: 'admin?', head: this.roster.head };
    const text = JSON.stringify(frame);
    for (const p of this.peers.values()) {
      if (p.state === 'p2p' && p.synced) try { p.link.sendChat(text); } catch { /* dying link */ }
    }
    this.#channel?.sendRelay(utf8.encode(text));
  }

  #after(ms, fn) {
    const timer = setTimeout(() => { this.#timers.delete(timer); fn(); }, ms);
    timer.unref?.();
    this.#timers.add(timer);
    return timer;
  }

  // ---- linked devices ---------------------------------------------------------------------

  #isUnlinked(cert, memberId) { return !!cert && this.#unlinked.has(`${memberId}|${cert.d}`); }

  /** Was this device certificate withdrawn (by an `unlink`) in this room? */
  isWithdrawn(cert, memberId) { return this.#isUnlinked(cert, memberId); }

  /** The main device's key: the one the identity is named after. It cannot be withdrawn. */
  #isRootKey(devicePub, env = null) {
    const root = env ? env.cert?.r ?? env.pub : this.identity.cert?.r ?? toB64u(this.identity.pub);
    return devicePub === root;
  }

  #noteUnlink(env) {
    if (!this.#isRootKey(env.body.d, env)) this.#unlinked.add(`${authorIdOf(env)}|${env.body.d}`);
  }

  /** Any device of ours: withdraw the certificate of a linked device (its public key,
   *  base64url) in this room. Everyone drops its links and refuses what it writes from then
   *  on. The main device cannot be withdrawn. */
  async unlinkDevice(devicePub) {
    if (this.#isRootKey(devicePub)) throw new Error('The main device cannot be unlinked');
    return this.#publish('unlink', unlinkBody(devicePub));
  }

  /** We learned elsewhere (not from an unlink in this room) that one of our devices was
   *  withdrawn: refuse it here too and close its links. */
  dropDevice(devicePub) {
    if (this.#isRootKey(devicePub)) return;
    this.#unlinked.add(`${this.identity.member}|${devicePub}`);
    for (const entry of this.peers.values()) {
      const ours = (entry.member ?? entry.id) === this.identity.member;
      if (ours && entry.pub && toB64u(entry.pub) === devicePub) entry.link.close();
    }
  }

  /** A certificate was withdrawn: close that device's links; if it was ours, say so. */
  #onUnlink(env) {
    if (this.#isRootKey(env.body.d, env)) return;
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
    entry.device = cert.n;
    this.#multi.add(member);
    // Approved by our pairing code under its device key, but it writes as `member`: admit that.
    if (entry.invited && this.isOwner && member !== entry.id && !this.roster.isMember(member)) {
      await this.#desk.admit(member, entry.name).catch(() => {});
    }
    if (this.roster && !entry.synced && this.#knows(member)) this.#markSynced(entry);
    this.#maybeSibling(entry);
    this.#emitPeers();
  }

  #sendCert(link) {
    if (this.identity.cert) link.sendChat(JSON.stringify({ t: 'cert', cert: this.identity.cert }));
    if (this.identity.alias) link.sendChat(JSON.stringify({ t: 'alias', n: this.identity.alias }));
  }

  /** Who may post what. Admin envelopes are checked by the roster itself. */
  #permits(env) {
    const author = authorIdOf(env);
    const owner = this.roster?.owner;
    const staff = !!this.roster?.isStaff(author);
    if (env.kind === 'del' && authorOfId(env.body.id) !== author && !staff) return false;
    if (env.kind === 'edit' && authorOfId(env.body.id) !== author) return false; // own only
    if (!this.roster) return !ADMIN_KINDS.includes(env.kind) && env.kind !== POLICY; // no owner
    if (ADMIN_KINDS.includes(env.kind)) return true;
    if (env.kind === POLICY) return author === owner; // only the owner sets the rules
    const target = env.kind === 'del' ? authorOfId(env.body.id) : null;
    return this.#knows(author) && this.policy.permits(env, author, owner, { target, staff });
  }

  /** Is `id` a member as far as we know, or one of our own devices (the main identity this
   *  device writes as)? Our own messages need no admission to be trusted by us: our list may
   *  lack our own admission (it can wait for a link nobody online has), and a device of ours
   *  must not refuse the others. */
  #knows(id) { return this.roster.isMember(id) || this.isMine(id); }

  async #accept(env, source, gossip = true) {
    const batch = this.roster && ADMIN_KINDS.includes(env.kind) ? this.roster.apply(env) : [env];
    for (const gone of this.roster?.retracted ?? []) await this.#takeBack(gone);
    let kept = false;
    for (const e of batch) {
      const done = await this.#keep(e, source, gossip);
      if (e === env) kept = done;
    }
    if (this.roster && ADMIN_KINDS.includes(env.kind)) await this.#saveWaiting();
    if (this.roster && this.#pending.size && batch.some((e) => ADMIN_KINDS.includes(e.kind))) {
      this.#after(0, () => this.#retryPending());
    }
    return kept;
  }

  #waitingSaved = '';
  #waitingKey() { return this.roster.waitingEnvs().map((e) => e.id).join(); }

  /** An admin envelope that cannot be applied yet (its predecessor is missing) is not part of
   *  the log, so it is kept on its own: a joiner's own admission may only ever have come with
   *  the grant, and was lost when the page restarted before the rest of the list arrived. */
  async #saveWaiting() {
    const key = this.#waitingKey();
    if (key === this.#waitingSaved) return;
    this.#waitingSaved = key;
    const held = this.roster.waitingEnvs();
    try {
      if (held.length) await this.#kv.put(`wait:${this.id}`, held);
      else await this.#kv.delete(`wait:${this.id}`);
    } catch (err) { console.error('could not save the member list', err); }
  }

  /** Older edits / reactions that `env` replaces; null if a newer one is already here. For one
   *  message only the latest edit counts, and per author and emoji only the latest reaction. */
  #superseded(env) {
    if (env.kind === POLICY) { // one set of rules at a time: the newest
      return this.policy.supersedes(env) ? this.log.where((e) => e.kind === POLICY) : null;
    }
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

  async #keep(env, source, gossip = true) {
    // nothing may ride on a deleted message (an edit would bring its text back)
    if (DECORATIONS.includes(env.kind) && this.log.isGone(env.body.id)) return false;
    const stale = this.#superseded(env);
    if (!stale) return false;
    const doomed = env.kind === 'del' ? this.log.get(env.body.id) : null;
    const orphans = env.kind === 'del' ? this.#decorations(env.body.id) : [];
    if (!this.log.add(env)) return false;
    this.#noteDevice(env);
    if (env.kind === POLICY) this.policy.set(env);
    this.log.drop([...stale, ...orphans]);
    this.hlc.observe(env);
    const removed = this.log.trim();
    const dropped = [...removed, ...stale, ...orphans, ...(doomed ? [doomed] : [])];
    await Promise.all([this.#store.save(env), this.#store.remove(dropped)])
      .catch((err) => console.error('could not save message', err));
    if (doomed) await this.#forget(doomed);
    if (ADMIN_KINDS.includes(env.kind)) await this.#onAdmin(env);
    if (env.kind === POLICY) await this.#onPolicy();
    if (env.kind === 'unlink') this.#onUnlink(env);
    const fresh = this.#marks.isUnread(env); // decided before a viewer can mark it read
    // Membership changes are shown in the conversation too ("Bob joined"): redraw for them.
    if (env.kind !== 'recovery' && !removed.includes(env)) this.emit('message', env);
    if (fresh && !removed.includes(env)) { this.emit('incoming', env); this.emit('unread'); }
    if (source && gossip) this.#sendToPeers(env, source.id); // heals meshes with a missing link
    this.#confirm(env);
    return true;
  }

  /** A moderator's admit lost a fork against another link made at the same time (see roster.js):
   *  forget it, and if it was ours, let that person in again on top of the winner. */
  async #takeBack(env) {
    this.log.drop([env]);
    await this.#store.remove([env]).catch(() => {});
    this.#emitPeers();
    this.emit('roster');
    const { id, name } = env.body;
    if (this.isMine(authorIdOf(env)) && !this.roster.isMember(id) && !this.roster.revoked.has(id)) {
      this.#after(0, () => this.#desk.admit(id, name).catch(() => {}));
    }
  }

  /** A membership change took effect. */
  async #onAdmin(env) {
    const { kind, body } = env;
    if (kind === 'admit') this.#desk.dropRequest(body.id); // answered, maybe on another device
    if (kind === 'admit' && body.role && this.isMine(body.id)) await this.#desk.sync(); // our role
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
    if (kind === 'transfer' || kind === 'recover') {
      await this.#desk.sync();
      this.#reassertRules();
    }
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
      const m = JSON.parse(fromUtf8(bytes));
      if (typeof m?.t === 'string') await this.#onRelayControl(m); // older versions ignore these
      else await this.#ingest(m, null);
    } catch { /* not a valid message */ }
  }

  /** What direct links do on connecting (member list, history), asked and answered over the
   *  brokers, for the pairs that cannot connect directly. Any member may answer; they wait a
   *  little, so that the others' answers (the same) are not sent N times. */
  async #onRelayControl(m) {
    if (m.t === 'admin?') {
      if (!this.roster?.chain.length || m.head === this.roster.head) return;
      this.#after(100 + Math.random() * 800, () => {
        if (Date.now() - this.#adminHeardAt < ANSWER_QUIET_MS) return; // someone answered already
        this.#relayBatches('admin', this.roster.envs(), 100);
      });
    } else if (m.t === 'admin' && Array.isArray(m.es)) {
      this.#adminHeardAt = Date.now();
      for (const e of m.es.slice(0, 100)) await this.#ingest(e, null).catch(() => {});
    } else if (m.t === 'have' && Array.isArray(m.ids)) {
      const ids = m.ids.filter((s) => typeof s === 'string').slice(0, 600);
      const missing = this.log.missingFor(ids, !!m.full).slice(-RELAY_GIVE_MAX);
      if (!missing.length) return;
      this.#after(100 + Math.random() * 800, () => {
        if (Date.now() - this.#giveSentAt < ANSWER_QUIET_MS) return;
        this.#giveSentAt = Date.now();
        this.#relayBatches('give', missing, 30);
      });
    } else if (m.t === 'ack') {
      if (m.to === this.identity.member) this.#onAck(m.by, m.ids);
    } else if (m.t === 'give' && Array.isArray(m.es)) {
      this.#giveSentAt = Date.now();
      for (const e of m.es.slice(0, 50)) await this.#ingest(e, null).catch(() => {});
    }
  }

  #relayBatches(t, envs, perFrame) {
    for (const es of this.#chunks(envs, perFrame)) {
      this.#channel?.sendRelay(utf8.encode(JSON.stringify({ t, es })));
    }
  }

  /** Tell the brokers what we have and which member list we know (and hear what we lack). */
  #relaySync() {
    if (!this.#channel || !this.settings.relayFallback) return;
    const send = (frame) => this.#channel.sendRelay(utf8.encode(JSON.stringify(frame)));
    send({
      t: 'have', ids: this.log.recentIds(RELAY_HAVE_IDS), full: this.log.size >= RELAY_HAVE_IDS,
    });
    if (this.roster) send({ t: 'admin?', head: this.roster.head });
  }

  async #onChat(entry, raw) {
    if (!entry.limiter.allow()) {
      if (!entry.limited) console.warn(`rate limit: frames of ${entry.name} are being dropped`);
      entry.limited = (entry.limited ?? 0) + 1;
      return;
    }
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m?.t === 'cert') { await this.#onCert(entry, m); return; }
    if (m?.t === 'alias') { // a device's own name for itself; only for display
      if (isAlias(m.n)) {
        entry.alias = m.n;
        this.#multi.add(entry.member ?? entry.id);
        this.#emitPeers();
      }
      return;
    }
    if (this.roster && m?.t === 'admin' && Array.isArray(m.es)) {
      for (const e of m.es.slice(0, 100)) await this.#ingest(e, null);
      if (!entry.synced && this.#knows(entry.member ?? entry.id)) this.#markSynced(entry);
      return;
    }
    if (this.roster && !entry.synced) return; // not (yet) known to be a member: ignored
    if (m?.t === 'sync') { // settings and aliases from another device of ours
      if (this.#isSibling(entry)) this.emit('sync', m.items, entry, m.epochs);
      return;
    }
    if (this.roster && m?.t === 'epoch') { await this.#onEpoch(m, entry); return; }
    if (m?.t === 'call') { this.call.onFrame(entry.id, m); return; }
    if (m?.t === 'ack') { this.#onAck(entry.member ?? entry.id, m.ids); return; }
    if (this.roster && m?.t === 'admin?') { // a member list asked for: send ours if it differs
      if (m.head !== this.roster.head) this.#sendAdmin(entry.link);
      return;
    }
    if (m?.t === 'msg') await this.#ingest(m.e, entry);
    else if (m?.t === 'have' && Array.isArray(m.ids)) this.#sendGive(
      entry.link,
      m.ids.filter((s) => typeof s === 'string'),
      !!m.full,
    );
    else if (m?.t === 'give' && Array.isArray(m.es)) {
      // History: one frame per 50 for the others, not a frame per message (the receiver's rate
      // limit would drop most of them, and live messages queued behind them).
      const news = [];
      for (const e of m.es.slice(0, 50)) if (await this.#ingest(e, entry, false)) news.push(e);
      this.#gossipBatch(news, entry.id);
    }
  }

  /** Forward messages we just learned from history to our other synced links, in `give` frames. */
  #gossipBatch(envs, exceptId) {
    if (!envs.length) return;
    for (const p of this.peers.values()) {
      if (p.state !== 'p2p' || !p.synced || p.id === exceptId) continue;
      try { this.#sendBatches(p.link, envs); } catch { /* link dying */ }
    }
  }

  // ---- history sync (on every new link) -------------------------------------------------------

  /** Membership comes first: both sides send their admin chain, and only talk chat once the
   *  other side is a known member. */
  #sendAdmin(link) {
    // At most 100 to a frame: that is all a receiver reads (more would lose the rest of the chain).
    for (const es of this.#chunks(this.roster.envs(), 100)) {
      link.sendChat(JSON.stringify({ t: 'admin', es }));
    }
  }

  #markSynced(entry) {
    entry.synced = true;
    this.call.peerUp(entry.id);
    this.#sendEpoch(entry.link);
    this.#sendHave(entry.link);
    this.#maybeSibling(entry);
    this.#emitPeers();
  }

  // ---- our other devices (same identity) -------------------------------------------------------

  /** Is this connection another device of ours? (A linked device proves it with its
   *  certificate; the main device's own id is the identity.) */
  #isSibling(entry) {
    return entry.id !== this.identity.id && (entry.member ?? entry.id) === this.identity.member;
  }

  /** Tell the app once that a connected, admitted device of ours is ready to exchange state. */
  #maybeSibling(entry) {
    if (entry.sibling || !entry.synced || entry.state !== 'p2p' || !this.#isSibling(entry)) return;
    entry.sibling = true;
    this.emit('sibling', entry);
  }

  /** Send a frame (a plain object) to one connected device of ours. */
  sendToSibling(entry, frame) {
    try { entry.link.sendChat(JSON.stringify(frame)); } catch { /* link dying */ }
  }

  /** Send a frame to every connected device of ours. */
  sendToSiblings(frame) {
    for (const entry of this.peers.values()) if (entry.sibling) this.sendToSibling(entry, frame);
  }

  /** Our alias changed: tell everyone we are connected to. */
  announceAlias() {
    const n = this.identity.alias ?? this.identity.cert?.n ?? '';
    for (const entry of this.peers.values()) {
      if (entry.state === 'p2p') this.sendToSibling(entry, { t: 'alias', n });
    }
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
    try { this.#sendBatches(link, missing); } catch { /* closed mid-sync; the next link retries */ }
  }

  /** `envs` in groups of at most `max` and MAX_FRAME_BYTES each. */
  *#chunks(envs, max = 50) {
    let batch = [], size = 0;
    for (const env of envs) {
      const n = JSON.stringify(env).length;
      if (batch.length && (size + n > MAX_FRAME_BYTES || batch.length >= max)) {
        yield batch;
        batch = [];
        size = 0;
      }
      batch.push(env); size += n;
    }
    if (batch.length) yield batch;
  }

  /** `give` frames of at most 50 messages and MAX_FRAME_BYTES each. */
  #sendBatches(link, envs) {
    for (const es of this.#chunks(envs)) link.sendChat(JSON.stringify({ t: 'give', es }));
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
        this.#maybeSibling(entry);
      } else {
        this.#sendAdmin(link);
        if (this.#knows(peer.id)) this.#markSynced(entry);
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
    // Files and previews only over links of members: a stranger asks for nothing, answers nothing.
    link.on('file', (data) => {
      if (!this.roster || entry.synced) this.files.onFrame(link, data);
    });
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
      id, name: this.#nameOf(id), owner: id === this.roster.owner, mod: this.roster.isMod(id),
      self: this.isMine(id), state: this.isMine(id) ? 'self' : live.get(id) ?? 'offline',
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

  #announce() {
    this.#channel?.announce({
      pub: this.identity.pub, name: this.#name, cert: this.identity.cert,
      alias: this.identity.alias, pv: PROTOCOL, app: VERSION,
    });
  }

  async #onPresence({ id, pub, name, member, device, alias, pv, app }) {
    if (this.roster?.revoked.has(member ?? id)) return;
    if (member && this.#isUnlinked({ d: toB64u(pub) }, member)) return; // a withdrawn device
    if (member || alias) this.#multi.add(member ?? id);
    const before = this.members.get(id);
    const isNew = !before;
    this.members.set(id, { pub, name, seen: Date.now(), member, device, alias, pv, app });
    if (isNew) { this.#emitPeers(); this.#announceSoon(); }
    else if (before.pv !== pv) this.#emitPeers(); // they updated (or went back)
    if ((member ?? id) === this.roster?.owner) this.#knockAgain(); // the owner is here
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
