// A folder as the File System Access API shows it, and a little of IndexedDB, for the tests of
// the folder backup.
export function fakeFolder({ files = {}, permission = 'granted', name = 'knot-bak' } = {}) {
  const data = new Map(Object.entries(files));
  const log = { writes: 0, aborts: 0 };
  const handle = {
    name,
    permission,
    answer: 'granted', // what the person says when asked again
    failWrite: false,
    queryPermission: async () => handle.permission,
    requestPermission: async () => { handle.permission = handle.answer; return handle.answer; },
    async getFileHandle(file, { create = false } = {}) {
      if (!data.has(file) && !create) {
        throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
      }
      return {
        getFile: async () => ({ arrayBuffer: async () => Uint8Array.from(data.get(file)).buffer }),
        async createWritable() {
          let pending = null;
          return {
            async write(bytes) {
              if (handle.failWrite) {
                throw Object.assign(new Error('full'), { name: 'QuotaExceededError' });
              }
              pending = Uint8Array.from(bytes);
            },
            async close() { data.set(file, pending); log.writes++; },
            async abort() { log.aborts++; },
          };
        },
      };
    },
  };
  return { handle, data, log };
}

/** Just enough of IndexedDB for IdbKV: one store; `dbs` are the connections made. */
export function fakeIndexedDb() {
  const data = new Map();
  const dbs = [];
  const connect = () => {
    const db = {
      onclose: null,
      onversionchange: null,
      close() {},
      transaction() {
        const tx = {};
        const done = () => setTimeout(() => tx.oncomplete(), 0);
        tx.objectStore = () => ({
          get: (key) => { done(); return { result: data.get(key) }; },
          put: (value, key) => { data.set(key, value); done(); return {}; },
          delete: (key) => { data.delete(key); done(); return {}; },
        });
        return tx;
      },
    };
    dbs.push(db);
    return db;
  };
  const indexedDB = {
    open() {
      const req = {};
      setTimeout(() => { req.result = connect(); req.onsuccess(); }, 0);
      return req;
    },
  };
  return { data, dbs, indexedDB };
}
