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
  /** `openTimeoutMs`: some browsers never answer `indexedDB.open` (after a restart of an
   *  installed app, with another connection stuck): fail with a reason instead of waiting. */
  constructor(name = 'knot', { openTimeoutMs = 20_000 } = {}) {
    this.name = name;
    this.openTimeoutMs = openTimeoutMs;
  }

  #open() {
    this.#db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, 1);
      let late = false;
      const timer = setTimeout(() => {
        late = true;
        this.#db = undefined; // the next call tries again
        const secs = this.openTimeoutMs / 1000;
        reject(new Error(`The browser storage did not answer within ${secs} s`));
      }, this.openTimeoutMs);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => {
        clearTimeout(timer);
        const db = req.result;
        if (late) { db.close?.(); return; }
        // WebKit closes idle connections behind our back, and another tab may want to upgrade:
        // forget this one, the next call opens a new one.
        db.onclose = db.onversionchange = () => { this.#db = undefined; db.close?.(); };
        resolve(db);
      };
      req.onerror = () => { clearTimeout(timer); this.#db = undefined; reject(req.error); };
    });
    return this.#db;
  }

  /** `use(db)`, once more on a fresh connection if the old one was closed under us. */
  async #withDb(use) {
    for (let attempt = 0; ; attempt++) {
      const db = await this.#open();
      try { return await use(db); } catch (err) {
        if (attempt > 0 || err?.name !== 'InvalidStateError') throw err;
        this.#db = undefined;
      }
    }
  }

  #run(mode, fn) {
    return this.#withDb((db) => new Promise((resolve, reject) => {
      const tx = db.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    }));
  }

  get(key) { return this.#run('readonly', (s) => s.get(key)); }
  put(key, value) { return this.#run('readwrite', (s) => s.put(value, key)); }
  delete(key) { return this.#run('readwrite', (s) => s.delete(key)); }

  list(prefix = '') {
    return this.#withDb((db) => new Promise((resolve, reject) => {
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
    }));
  }
}
