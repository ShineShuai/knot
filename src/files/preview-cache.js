// Persistent per-room cache of image previews (and tiny originals) in the KV store.
// Previews are content-addressed and verified against the signed envelope before they
// get here, so this cache can also serve them to other peers when the author is away.
// Values are ArrayBuffers (Blobs in IndexedDB are unreliable on Safari). A small index
// record tracks size and last use for LRU eviction without loading any image data.
export class PreviewCache {
  #kv; #room; #cap; #index = null; #queue = Promise.resolve();

  constructor(kv, roomId, capBytes = 64 * 1024 * 1024) {
    this.#kv = kv;
    this.#room = roomId;
    this.#cap = capBytes;
  }

  get #indexKey() { return `pvx:${this.#room}`; }
  #key(id) { return `pv:${this.#room}:${id}`; }

  /** Run `fn` after all earlier operations: index updates must not interleave. */
  #serial(fn) {
    const run = this.#queue.then(fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  async #load() { return (this.#index ??= (await this.#kv.get(this.#indexKey)) ?? []); }

  /** The cached bytes as an untyped Blob, or null. */
  blob(id) {
    return this.#serial(async () => {
      const index = await this.#load();
      const entry = index.find((e) => e.id === id);
      const data = entry && await this.#kv.get(this.#key(id));
      if (!data) return null;
      if (Date.now() - entry.ts > 60_000) { // refresh recency, but not on every read
        entry.ts = Date.now();
        await this.#kv.put(this.#indexKey, index);
      }
      return new Blob([data]);
    });
  }

  /** Store a verified blob under `id`, evicting the least recently used to stay in budget. */
  put(id, blob) {
    return this.#serial(async () => {
      const data = await blob.arrayBuffer();
      let index = (await this.#load()).filter((e) => e.id !== id);
      await this.#kv.put(this.#key(id), data);
      index.push({ id, size: data.byteLength, ts: Date.now() });
      let total = index.reduce((n, e) => n + e.size, 0);
      const evict = [];
      for (const e of [...index].sort((a, b) => a.ts - b.ts)) {
        if (total <= this.#cap) break;
        if (e.id !== id) { evict.push(e); total -= e.size; }
      }
      index = index.filter((e) => !evict.includes(e));
      await Promise.all(evict.map((e) => this.#kv.delete(this.#key(e.id))));
      this.#index = index;
      await this.#kv.put(this.#indexKey, index);
    });
  }

  /** Forget one entry (its message was deleted). */
  delete(id) {
    return this.#serial(async () => {
      const index = (await this.#load()).filter((e) => e.id !== id);
      if (index.length === this.#index.length) return;
      await this.#kv.delete(this.#key(id));
      this.#index = index;
      await this.#kv.put(this.#indexKey, index);
    });
  }

  /** Forget everything of this room (called when the user leaves it). */
  clear() {
    return this.#serial(async () => {
      const index = await this.#load();
      await Promise.all(index.map((e) => this.#kv.delete(this.#key(e.id))));
      await this.#kv.delete(this.#indexKey);
      this.#index = [];
    });
  }
}
