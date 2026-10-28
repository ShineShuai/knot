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
import { HLC, compareStamps } from '../util/hlc.js';
import { RateLimiter } from '../util/rate.js';
import {
  concat, fromB64u, fromUtf8, randomBytes, sha256, toB64u, utf8,
} from '../util/bytes.js';
import { identityFromSeed, peerIdOf } from '../crypto/identity.js';
import { deriveRoomKeys } from '../crypto/room-keys.js';
import { encodeRecoveryCode } from './recovery.js';
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
import { CallManager } from '../call/call.js';
import { FileTransfer } from '../files/transfer.js';
import { PreviewCache } from '../files/preview-cache.js';
import { asImage } from '../files/image.js';
import {
  ADMIN_KINDS, admitBody, authorIdOf, authorOfId, createEnvelope, delBody, editBody, isEmoji,
  previewRef, quoteOf, reactBody, recoverBody, recoveryBody, replyBody, revokeBody, transferBody,
  verifyEnvelope,
} from './envelope.js';
import { MessageLog, byStamp } from './log.js';
import { MessageStore } from './message-store.js';
import { Roster } from './roster.js';
import { lobbyKeys, lobbySecretOf, makeDeny, makeGrant, readRequest } from './lobby.js';

const SEEN_SESSIONS_LIMIT = 200;
const MAX_FRAME_BYTES = 48 * 1024; // keep chat frames well under every browser's SCTP limit
const REDIAL_MS = 10000;
const MAX_JOIN_REQUESTS = 50;
const UNREAD_KINDS = ['text', 'reply', 'file']; // what counts as a message to catch up on
const DECORATIONS = ['edit', 'react']; // envelopes that ride on another message

export class Room extends Emitter {
  /** peerId -> { id, pub, name, link, via:'broker'|'manual', state:'connecting'|'p2p', sas } */
  peers = new Map();
  /** peerId -> { pub, name, seen } for everyone announcing on the brokers */
  members = new Map();

  #chan; #store; #kv; #channel = null; #timers = new Set();
  #epoch = { n: 0, secret: null }; // key rotations: the channel keys depend on it
  #recoverWith = null; #recovering = false; // a recovery code in use on this device
  #pulls = new Map();        // preview id -> in-flight fetch (shared by every asker)
  #joinRequests = new Map(); // joiner id -> request waiting for the owner's decision
  #lobby = null; #lobbyId = null;
  #read = { ms: 0, c: 0 };   // stamp of the newest message seen on this device
  #pending = new Map();      // session -> { link, offer, peer|null } handshakes awaiting an answer
  #seenSessions = new Set(); // offers already answered (replay protection)
  #dialedAt = new Map();

  static async open(opts) {
    const keys = await deriveRoomKeys(opts.secret);
    const room = new Room(opts, keys);
    await room.#load();
    return room;
  }

  constructor(
    {
      identity, secret, label, owner = null, kv, settings, iceServers, linkFactory, WS, derive,
      callEnv = {},
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
    this.hlc = new HLC();
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
    this.call = new CallManager({
      selfId: identity.id, settings, iceServers: () => this.iceServers(),
      send: (id, frame) => this.#sendCall(id, frame), ...callEnv,
    });
  }

  get #name() { return this.settings.name || `anon-${this.identity.id.slice(0, 4)}`; }

  /** Everyone we know of in this room, for display. state: p2p | relay | connecting | seen */
  get peerList() {
    const viaRelay = (id) => !!this.#channel && this.settings.relayFallback && this.#isFresh(
      this.members.get(id) ?? { seen: 0 },
    );
    const owner = (id) => id === this.roster?.owner;
    const rows = [...this.peers.values()].map(({ id, name, state, via, sas }) => ({
      id, name, via, sas, owner: owner(id),
      state: state === 'p2p' || !viaRelay(id) ? state : 'relay',
    }));
    for (const [id, m] of this.members) {
      if (!this.peers.has(id) && this.#isFresh(m)) rows.push({
        id, name: m.name, state: viaRelay(id) ? 'relay' : 'seen', via: 'broker', sas: null,
        owner: owner(id),
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
    this.removed = !!this.roster?.revoked.has(this.identity.id);
    const mark = await this.#kv.get(`read:${this.id}`);
    this.#read = mark ?? this.#newestStamp(); // first run: what is here counts as read
    if (!mark) await this.#kv.put(`read:${this.id}`, this.#read).catch(() => {});
    const saved = await this.#kv.get(`epoch:${this.id}`);
    if (saved?.n) {
      this.#epoch = { n: saved.n, secret: fromB64u(saved.s) };
      this.#chan = await deriveRoomKeys(this.#chanSecret());
    }
  }

  #newestStamp() {
    const last = this.log.list().at(-1);
    return last ? { ms: last.ms, c: last.c } : { ms: 0, c: 0 };
  }

  #isUnread(env) {
    return UNREAD_KINDS.includes(env.kind) && authorIdOf(env) !== this.identity.id
      && compareStamps(env, this.#read) > 0;
  }

  /** Messages from others that this device has not shown to its user yet. */
  get unread() { return this.log.where((e) => this.#isUnread(e)).length; }

  /** The user has seen everything up to now (they are looking at this room). */
  async markRead() {
    const newest = this.#newestStamp();
    if (compareStamps(newest, this.#read) <= 0) return;
    this.#read = newest;
    this.emit('unread');
    await this.#kv.put(`read:${this.id}`, newest).catch(() => {});
  }

  /** What the broker channel and lobby keys derive from: the room secret, mixed with the
   *  latest rotation's secret once a member has been removed. */
  #chanSecret() {
    return this.#epoch.n ? concat(this.secret, this.#epoch.secret) : this.secret;
  }

  get epoch() { return this.#epoch.n; }
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

  // ---- lifecycle -------------------------------------------------------------------

  start() {
    if (this.removed || !this.settings.brokersEnabled || !this.settings.brokers.length) return;
    this.#openChannel();
    this.#every(this.settings.presenceIntervalMs, () => this.#announce());
    this.#syncLobby().catch(() => {});
  }

  #openChannel() {
    this.#channel = new RoomChannel({
      roomId: this.#chan.id, aes: this.#chan.aes, selfId: this.identity.id, WS: this.WS,
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
    if (this.#lobby) {
      this.#lobby.stop();
      this.#lobby = null;
      this.#joinRequests.clear();
      await this.#syncLobby(); // old join links stop working
    }
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
    this.#lobby?.stop();
    for (const { link } of this.#pending.values()) link.close();
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
    if (authorOfId(id) !== this.identity.id && !this.isOwner) {
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
    if (authorIdOf(env) !== this.identity.id) {
      throw new Error('You can only edit your own messages');
    }
    if (text === this.log.textOf(env)) return null;
    return this.#publish('edit', editBody(id, text));
  }

  /** Switch our reaction `emoji` on message `id` on or off. */
  async react(id, emoji) {
    if (!isEmoji(emoji)) throw new Error('Not an emoji');
    if (!this.log.get(id)) throw new Error('That message is gone');
    const mine = this.log.overlay().reactions.get(id)?.get(emoji)?.includes(this.identity.id);
    return this.#publish('react', reactBody(id, emoji, !mine));
  }

  async shareFile(file) {
    if (file.size > this.settings.maxFileBytes) throw new Error('File too large');
    const body = await this.files.share(file);
    const ref = previewRef(body); // keep our own preview: it must outlive a reload
    const own = ref && this.files.local(ref.id);
    if (own) await this.previews.put(ref.id, own).catch(() => {});
    return this.#publish('file', body);
  }

  /**
   * The small viewable rendition of a shared image (its preview, or the original when it
   * is tiny) as a typed Blob; null if the message has none. Served from memory or the
   * cache when possible, otherwise fetched from the author or any peer that has it.
   */
  async previewBlob(env) {
    const ref = previewRef(env.body);
    if (!ref) return null;
    let raw = this.files.local(ref.id) ?? await this.previews.blob(ref.id);
    if (!raw) {
      let pull = this.#pulls.get(ref.id);
      if (!pull) {
        pull = this.#pull(env, ref).finally(() => this.#pulls.delete(ref.id));
        this.#pulls.set(ref.id, pull);
      }
      raw = await pull;
    }
    return asImage(raw);
  }

  /** Try the author first, then every other direct peer (previews are verifiable by hash). */
  async #pull(env, ref) {
    const author = authorIdOf(env);
    const links = [...this.peers.values()]
      .filter((p) => p.state === 'p2p' && p.link.state === 'open')
      .sort((a, b) => (b.id === author) - (a.id === author))
      .map((p) => p.link);
    if (!links.length) throw new Error('The sender is not connected right now');
    let failure;
    for (const link of links) {
      try {
        const blob = await this.files.download(link, ref);
        if (!(await asImage(blob))) throw new Error('Not a valid image');
        await this.previews.put(ref.id, blob).catch(() => {});
        return blob;
      } catch (err) { failure = err; }
    }
    throw failure;
  }

  /** Fetch a shared file directly from its author. Resolves to a Blob. */
  async downloadFile(env, onProgress) {
    const own = authorIdOf(env) === this.identity.id && this.files.local(env.body.id);
    if (own) return own;
    const link = this.peers.get(authorIdOf(env))?.link;
    if (link?.state !== 'open') throw new Error('The sender is not connected right now');
    return this.files.download(link, env.body, onProgress);
  }

  async #publish(kind, body, signer = this.identity) {
    if (this.removed) throw new Error('You were removed from this room');
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
    if (!this.#permits(env)) return false;
    return this.#accept(env, source);
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
    const fresh = this.#isUnread(env); // decided before a viewer can mark it read
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
      if (body.id === this.identity.id) return this.#beRemoved();
      this.members.delete(body.id);
      this.call.peerDown(body.id);
      this.#joinRequests.delete(body.id);
      const peer = this.peers.get(body.id);
      if (peer) { // tell them first, so their app can say so, then drop the link
        try { peer.link.sendChat(JSON.stringify({ t: 'admin', es: [env] })); } catch { /* gone */ }
        const timer = setTimeout(() => peer.link.close(), 300);
        timer.unref?.();
      }
    }
    if (kind === 'recover' && this.roster.revoked.has(this.identity.id)) return this.#beRemoved();
    if (kind === 'transfer' || kind === 'recover') await this.#syncLobby();
    this.#emitPeers();
    this.emit('roster');
    await this.#tryRecover();
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
    if (this.roster && m?.t === 'admin' && Array.isArray(m.es)) {
      for (const e of m.es.slice(0, 100)) await this.#ingest(e, null);
      if (!entry.synced && this.roster.isMember(entry.id)) this.#markSynced(entry);
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

  #watchPending(offer, link, peer, ttlMs) {
    const key = toB64u(offer.session);
    this.#pending.set(key, { link, offer, peer });
    const timer = setTimeout(() => {
      if (this.#pending.delete(key) && !peer) link.close(); // unanswered manual invite
    }, ttlMs);
    timer.unref?.();
    this.#timers.add(timer);
  }

  async #newOffer({ roomSecret, founder = null }) {
    const link = this.#newLink();
    try {
      const sdp = await link.createOffer();
      const offer = await signHandshake(this.identity, {
        kind: 'offer', session: randomBytes(8), ts: Date.now(), name: this.#name, roomSecret,
        founder, sdp,
      });
      return { link, offer };
    } catch (err) { link.close(); throw err; }
  }

  /** Verify an offer and build our answer. Shared by manual and broker paths. */
  async #answer(offer, via) {
    const peer = { id: await peerIdOf(offer.pub), pub: offer.pub, name: offer.name };
    if (peer.id === this.identity.id) throw new Error('That code was made by this device');
    if (this.roster?.revoked.has(peer.id)) throw new Error('This person was removed from the room');
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
    // Pairing by a code the owner made is the owner's approval; a broker dial is not.
    if (this.isOwner && !pending.peer) await this.#admit(id, answer.name).catch(() => {});
    await pending.link.acceptAnswer(answer.sdp);
    return true;
  }

  // ---- manual pairing (no server needed)
  // ---------------------------------------------------------------

  /** Step 1 (inviter): returns a code to hand to the other person. */
  async createInvite() {
    if (this.roster && !this.isOwner) {
      throw new Error('Only the room owner can create pairing codes');
    }
    const { link, offer } = await this.#newOffer(
      { roomSecret: this.secret, founder: this.roster?.founder ?? null },
    );
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

  // ---- owner: members and join requests ------------------------------------------------------

  #requireOwner() { if (!this.isOwner) throw new Error('Only the room owner can do this'); }

  /** Everyone in the room (owner first), for the members list. */
  membersView() {
    if (!this.roster) return [];
    const live = new Map(this.peerList.map((p) => [p.id, p.state]));
    return [this.roster.owner, ...this.roster.members.keys()].map((id) => ({
      id, name: this.#nameOf(id), owner: id === this.roster.owner, self: id === this.identity.id,
      state: id === this.identity.id ? 'self' : live.get(id) ?? 'offline',
    }));
  }

  /** A readable name for someone in this room, even after they left. */
  nameOf(id) { return this.#nameOf(id); }

  #nameOf(id) {
    if (id === this.identity.id) return this.#name;
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

  get joinRequests() {
    return [...this.#joinRequests.values()].map(({ id, name, greeting, ts }) => (
      { id, name, greeting, ts }
    ));
  }

  /** Owner only: let a requester in. They get the room secret, sealed to them alone. */
  async approveJoin(id) {
    this.#requireOwner();
    const req = this.#joinRequests.get(id);
    if (!req) throw new Error('This request is no longer open');
    await this.#admit(req.id, req.name);
    await this.#grant(req);
    this.#joinRequests.delete(id);
    this.emit('requests');
  }

  async declineJoin(id) {
    this.#requireOwner();
    const req = this.#joinRequests.get(id);
    if (!req) return;
    this.#joinRequests.delete(id);
    this.emit('requests');
    await this.#lobby?.sendSignal(
      req.id, await makeDeny(this.identity, { lobbyId: this.#lobbyId, to: req.id }),
    );
  }

  /** Owner only: remove a member. Honest peers drop their links and ignore them from now on,
   *  and the room moves to new channel keys that the removed member never gets. Old recovery
   *  codes stop working: make a new one (see newRecoveryCode). */
  async removeMember(id) {
    this.#requireOwner();
    if (id === this.identity.id) throw new Error('Transfer the room first, then leave it');
    if (!this.roster.isMember(id)) throw new Error('Not a member of this room');
    const [n, secret] = [this.#epoch.n + 1, randomBytes(16)];
    const commit = toB64u(await sha256(secret));
    const env = await this.#publish(
      'revoke', revokeBody({ id, epoch: { n, commit } }, this.roster.head),
    );
    await this.#applyEpoch(n, secret);
    this.#shareEpoch(id);
    return env;
  }

  // ---- recovery: taking the room back after the owner's identity is lost -----------------------

  /** Owner only: a new recovery code (and the old one stops working). Show it once, to keep
   *  offline; it is not stored here. */
  async newRecoveryCode() {
    this.#requireOwner();
    const seed = randomBytes(32);
    const key = await identityFromSeed(seed);
    await this.#publish('recovery', recoveryBody({ key: toB64u(key.pub) }, this.roster.head));
    const epoch = this.#epoch.n ? this.#epoch : null;
    return encodeRecoveryCode({
      secret: this.secret, founder: this.roster.founder, seed, epoch,
    });
  }

  /** On a new device with a recovery code: as soon as a member shows us the chain (and it
   *  holds this code's key), claim the room. Needs one member online. */
  async beginRecovery(seed) {
    this.#recoverWith = await identityFromSeed(seed);
    await this.#tryRecover();
  }

  get recovering() { return !!this.#recoverWith && !this.isOwner; }

  async #tryRecover() {
    const key = this.#recoverWith;
    if (!key || this.#recovering || this.isOwner || this.removed) return;
    if (this.roster.recoveryKey !== toB64u(key.pub)) return; // chain not seen yet, or code stale
    this.#recovering = true;
    try {
      const [n, secret] = [this.#epoch.n + 1, randomBytes(16)];
      const commit = toB64u(await sha256(secret));
      const env = await this.#publish('recover', recoverBody(
        { to: this.identity.id, epoch: { n, commit } }, this.roster.head,
      ), key);
      // Members still treat us as a stranger: only admin frames get through until they apply it.
      const frame = JSON.stringify({ t: 'admin', es: [env] });
      for (const p of this.peers.values()) if (p.state === 'p2p') p.link.sendChat(frame);
      await this.#applyEpoch(n, secret);
      this.#shareEpoch(null);
      this.#recoverWith = null;
      this.emit('recovered');
    } finally { this.#recovering = false; }
  }

  /** Owner only: hand the room to another member. Old join links stop working. */
  async transferOwnership(id) {
    this.#requireOwner();
    if (!this.roster.members.has(id)) throw new Error('Pick a current member');
    return this.#publish('transfer', transferBody({ to: id }, this.roster.head));
  }

  /** Feed an owner-signed envelope (the approval that came with the grant). */
  receiveAdmin(env) { return this.#ingest(env, null); }

  #admit(id, name) {
    if (this.roster.isMember(id)) return null;
    return this.#publish('admit', admitBody({ id, name }, this.roster.head));
  }

  async #grant(req) {
    const admit = this.roster.chain.findLast((e) => e.kind === 'admit' && e.body.id === req.id);
    const epoch = this.#epoch.n ? { n: this.#epoch.n, s: toB64u(this.#epoch.secret) } : null;
    const payload = {
      secret: this.secret, label: this.label, admit, founder: this.roster.founder, epoch,
    };
    await this.#lobby?.sendSignal(req.id, await makeGrant(
      this.identity, { lobbyId: this.#lobbyId, to: req.id, boxPub: req.boxPub, payload },
    ));
  }

  /** The owner listens in the lobby; nobody else does. Follows ownership changes. */
  async #syncLobby() {
    const { settings } = this;
    const want = this.isOwner && !this.removed && settings.brokersEnabled
      && settings.brokers.length > 0;
    if (!want) {
      this.#lobby?.stop();
      this.#lobby = null;
      this.#joinRequests.clear();
      return;
    }
    if (this.#lobby) return;
    const keys = await lobbyKeys(await lobbySecretOf(this.#chanSecret()), this.identity.id);
    this.#lobbyId = keys.id;
    this.#lobby = new RoomChannel({
      roomId: keys.id, aes: keys.aes, selfId: this.identity.id, WS: this.WS,
      brokers: settings.brokers, topicPrefix: settings.topicPrefix,
    });
    this.#lobby.on('signal', (bytes) => this.#onJoinRequest(bytes));
    this.#lobby.start();
  }

  async #onJoinRequest(bytes) {
    const req = await readRequest(bytes, this.#lobbyId);
    if (!req || !this.isOwner || req.id === this.identity.id) return;
    if (this.roster.revoked.has(req.id)) return;
    if (this.roster.isMember(req.id)) return void this.#grant(req).catch(() => {}); // knocked twice
    const isNew = !this.#joinRequests.has(req.id);
    if (isNew && this.#joinRequests.size >= MAX_JOIN_REQUESTS) return;
    this.#joinRequests.set(req.id, req);
    if (isNew) this.emit('requests');
  }

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
