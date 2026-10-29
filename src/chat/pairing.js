// Connecting two devices: by a code handed over by hand (no server) or by offers and answers
// sent through the brokers. Verifies the handshakes and hands the open link to the room.
import { peerIdOf } from '../crypto/identity.js';
import {
  encodeCode, shortAuthString, signHandshake, unpackHandshake, verifyHandshake,
} from '../net/handshake.js';
import { randomBytes, toB64u } from '../util/bytes.js';

const SEEN_SESSIONS_LIMIT = 200;
const REDIAL_MS = 10000;

export class Pairing {
  #pending = new Map();      // session -> { link, offer, peer|null } handshakes awaiting an answer
  #seenSessions = new Set(); // offers already answered (replay protection)
  #dialedAt = new Map();

  /** `hooks`: attach(link, peer, via), newLink(), emitPeers(), admit(id, name), channel(),
   *  name(), track(timer): what only the room can do. */
  constructor(room, hooks) {
    this.room = room;
    this.hooks = hooks;
  }

  /** The room stops: close the handshakes still open. */
  stop() {
    for (const { link } of this.#pending.values()) link.close();
  }

  #watchPending(offer, link, peer, ttlMs) {
    const key = toB64u(offer.session);
    this.#pending.set(key, { link, offer, peer });
    const timer = setTimeout(() => {
      if (this.#pending.delete(key) && !peer) link.close(); // unanswered manual invite
    }, ttlMs);
    timer.unref?.();
    this.hooks.track(timer);
  }

  async #newOffer({ roomSecret, founder = null }) {
    const link = this.hooks.newLink();
    try {
      const sdp = await link.createOffer();
      const offer = await signHandshake(this.room.identity, {
        kind: 'offer', session: randomBytes(8), ts: Date.now(), name: this.hooks.name(), roomSecret,
        founder, sdp,
      });
      return { link, offer };
    } catch (err) { link.close(); throw err; }
  }

  /** Verify an offer and build our answer. Shared by manual and broker paths. */
  async #answer(offer, via) {
    const peer = { id: await peerIdOf(offer.pub), pub: offer.pub, name: offer.name };
    if (peer.id === this.room.identity.id) throw new Error('That code was made by this device');
    if (this.room.roster?.revoked.has(peer.id)) {
      throw new Error('This person was removed from the room');
    }
    const session = toB64u(offer.session);
    if (this.#seenSessions.has(session)) throw new Error('This code was already used');
    this.#seenSessions.add(session);
    if (this.#seenSessions.size > SEEN_SESSIONS_LIMIT) this.#seenSessions.delete(
      this.#seenSessions.values().next().value,
    );

    const link = this.hooks.newLink();
    const entry = this.hooks.attach(link, peer, via);
    if (!entry) throw new Error('Already connected to this peer');
    try {
      const sdp = await link.acceptOffer(offer.sdp);
      const answer = await signHandshake(this.room.identity, {
        kind: 'answer', session: offer.session, ts: Date.now(),
        name: this.hooks.name(), roomSecret: null, sdp,
      });
      entry.sas = await shortAuthString(offer.sdp.fingerprint, sdp.fingerprint);
      this.hooks.emitPeers();
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
    const entry = pending.peer ? this.room.peers.get(id) : this.hooks.attach(
      pending.link,
      { id, pub: answer.pub, name: answer.name },
      'manual',
    );
    if (entry?.link !== pending.link) { pending.link.close(); return false; }
    entry.sas = await shortAuthString(pending.offer.sdp.fingerprint, answer.sdp.fingerprint);
    this.hooks.emitPeers();
    // Pairing by a code the owner made is the owner's approval; a broker dial is not.
    if (this.room.isOwner && !pending.peer) await this.hooks.admit(id, answer.name).catch(() => {});
    await pending.link.acceptAnswer(answer.sdp);
    return true;
  }

  /** Step 1 (inviter): returns a code to hand to the other person. */
  async createInvite() {
    if (this.room.roster && !this.room.isOwner) {
      throw new Error('Only the room owner can create pairing codes');
    }
    const { link, offer } = await this.#newOffer(
      { roomSecret: this.room.secret, founder: this.room.roster?.founder ?? null },
    );
    this.#watchPending(offer, link, null, this.room.settings.inviteTtlMs);
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

  async dial(peer) {
    if (Date.now() - (this.#dialedAt.get(peer.id) ?? 0) < REDIAL_MS) return;
    this.#dialedAt.set(peer.id, Date.now());
    try {
      const { link, offer } = await this.#newOffer({ roomSecret: null });
      if (!this.hooks.attach(link, peer, 'broker')) return;
      this.#watchPending(offer, link, peer, this.room.settings.connectTimeoutMs);
      await this.hooks.channel().sendSignal(peer.id, offer.wire);
    } catch { /* retried at the next presence announcement */ }
  }

  async onSignal(bytes) {
    try {
      const h = unpackHandshake(bytes);
      await verifyHandshake(h);
      if (h.kind === 'answer') return void (await this.#finish(h));
      const { answer } = await this.#answer(h, 'broker');
      await this.hooks.channel().sendSignal(await peerIdOf(h.pub), answer.wire);
    } catch { /* bad, stale or duplicate signal: ignore */ }
  }
}
