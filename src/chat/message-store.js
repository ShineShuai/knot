// Persists a room's messages in a KV store, one record per message.
export class MessageStore {
  #kv; #prefix;
  constructor(kv, roomId) { this.#kv = kv; this.#prefix = `m:${roomId}:`; }
  async loadAll() { return (await this.#kv.list(this.#prefix)).map(([, env]) => env); }
  save(env) { return this.#kv.put(this.#prefix + env.id, env); }
  async clear() {
    for (const [key] of await this.#kv.list(this.#prefix)) await this.#kv.delete(key);
  }
  async remove(envs) { await Promise.all(envs.map((e) => this.#kv.delete(this.#prefix + e.id))); }
}
