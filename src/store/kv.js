// Tiny async key-value stores with one API: IndexedDB for the browser, a Map for tests.
export class MemoryKV {
  #map = new Map();
  async get(key) { return this.#map.get(key); }
  async put(key, value) { this.#map.set(key, value); }
  async delete(key) { this.#map.delete(key); }
  /** All [key, value] pairs whose key starts with `prefix`, sorted by key. */
  async list(prefix = '') {
    return [...this.#map].filter(([k]) => k.startsWith(prefix)).sort(
      ([a], [b]) => (a < b ? -1 : 1),
    );
  }
}

export class IdbKV {
  #db;
  constructor(name = 'knot') { this.name = name; }

  #open() {
    this.#db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.#db;
  }

  async #run(mode, fn) {
    const db = await this.#open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }

  get(key) { return this.#run('readonly', (s) => s.get(key)); }
  put(key, value) { return this.#run('readwrite', (s) => s.put(value, key)); }
  delete(key) { return this.#run('readwrite', (s) => s.delete(key)); }

  async list(prefix = '') {
    const db = await this.#open();
    return new Promise((resolve, reject) => {
      const out = [];
      const range = IDBKeyRange.bound(prefix, prefix + '\uffff');
      const req = db.transaction('kv').objectStore('kv').openCursor(range);
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve(out);
        out.push([cur.key, cur.value]);
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }
}
