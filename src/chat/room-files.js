// What a room does with files: share one, fetch one from its sender, and get the small
// preview of an image (from the sender, or from any peer that has it).
import { asImage } from '../files/image.js';
import { authorIdOf, previewRef } from './envelope.js';

export class RoomFiles {
  #pulls = new Map(); // preview id -> in-flight fetch (shared by every asker)

  /** `publish(kind, body)`: sign and send an envelope of the room. */
  constructor(room, publish) {
    this.room = room;
    this.publish = publish;
  }

  async share(file) {
    if (file.size > this.room.settings.maxFileBytes) throw new Error('File too large');
    const body = await this.room.files.share(file);
    const ref = previewRef(body); // keep our own preview: it must outlive a reload
    const own = ref && this.room.files.local(ref.id);
    if (own) await this.room.previews.put(ref.id, own).catch(() => {});
    return this.publish('file', body);
  }

  /**
   * The small viewable rendition of a shared image (its preview, or the original when it
   * is tiny) as a typed Blob; null if the message has none. Served from memory or the
   * cache when possible, otherwise fetched from the author or any peer that has it.
   */
  async previewBlob(env) {
    const ref = previewRef(env.body);
    if (!ref) return null;
    let raw = this.room.files.local(ref.id) ?? await this.room.previews.blob(ref.id);
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
    const links = [...this.room.peers.values()]
      .filter((p) => p.state === 'p2p' && p.link.state === 'open')
      .sort((a, b) => ((b.member ?? b.id) === author) - ((a.member ?? a.id) === author))
      .map((p) => p.link);
    if (!links.length) throw new Error('The sender is not connected right now');
    let failure;
    for (const link of links) {
      try {
        const blob = await this.room.files.download(link, ref);
        if (!(await asImage(blob))) throw new Error('Not a valid image');
        await this.room.previews.put(ref.id, blob).catch(() => {});
        return blob;
      } catch (err) { failure = err; }
    }
    throw failure;
  }

  /** Fetch a shared file directly from its author. Resolves to a Blob. */
  async download(env, onProgress) {
    const author = authorIdOf(env);
    const own = this.room.isMine(author) && this.room.files.local(env.body.id);
    if (own) return own;
    const links = this.#linksOf(author); // the author may have several devices
    if (!links.length) throw new Error('The sender is not connected right now');
    let failure;
    for (const link of links) {
      try { return await this.room.files.download(link, env.body, onProgress); } catch (err) {
        failure = err;
      }
    }
    throw failure;
  }

  /** Open direct links to the devices of one member. */
  #linksOf(memberId) {
    return [...this.room.peers.values()]
      .filter((p) => p.state === 'p2p' && p.link.state === 'open')
      .filter((p) => (p.member ?? p.id) === memberId)
      .map((p) => p.link);
  }
}
