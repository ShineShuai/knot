// A backup kept up to date in a folder the person picked (Chrome and Edge on a computer: the
// File System Access API; Firefox and Safari have no folder picker). The file is the same
// encrypted one as "Save backup" (store/backup.js). The passphrase is asked once: what is kept
// is the key made from it (the browser stores it without ever showing it to the page), so
// saving needs no prompt. The folder handle is kept in the store too, so a wipe of the site's
// data loses the handle but not the files: the person picks the folder again and restores.
import { Emitter } from '../util/emitter.js';
import { collect, countOf, isBackupKey, seal } from './backup.js';

export const FOLDER_FILE = 'knot-backup.knotbk';
export const PREVIOUS_FILE = 'knot-backup.prev.knotbk';
const DELAY_MS = 30_000; // changes are written together, at most this often

export const canPickFolder = (env = globalThis) => typeof env.showDirectoryPicker === 'function';

/** Ask for a folder to write to; null if the person closed the picker. */
export async function pickFolder(env = globalThis) {
  try {
    return await env.showDirectoryPicker({
      id: 'knot-backup', mode: 'readwrite', startIn: 'documents',
    });
  } catch (err) {
    if (err?.name === 'AbortError') return null;
    throw err;
  }
}

/** The backup file already in `handle`, as bytes, or null. */
export async function readBackup(handle) {
  try {
    const file = await (await handle.getFileHandle(FOLDER_FILE)).getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    if (err?.name === 'NotFoundError') return null;
    throw err;
  }
}

async function writeFile(handle, name, bytes) {
  const out = await (await handle.getFileHandle(name, { create: true })).createWritable();
  try {
    await out.write(bytes);
    await out.close(); // the file changes only now: a failed write leaves the old one whole
  } catch (err) {
    await out.abort?.().catch(() => {});
    throw err;
  }
}

/** Keep the file that is there under another name, before it is replaced. */
export const keepPrevious = (handle, bytes) => writeFile(handle, PREVIOUS_FILE, bytes);

/** Events: 'state' (`state`: off | ok | needs_permission | error, with `error` as text). */
export class FolderBackup extends Emitter {
  state = 'off';
  error = '';
  #kv;
  #delay;
  #now;
  #record = null; // { handle, key, salt, iterations, at }
  #dirty = false;
  #timer = null;
  #chain = Promise.resolve(); // one write at a time

  constructor({ kv, delayMs = DELAY_MS, now = Date.now } = {}) {
    super();
    this.#kv = kv;
    this.#delay = delayMs;
    this.#now = now;
  }

  get active() { return !!this.#record; }
  get name() { return this.#record?.handle?.name ?? ''; }
  get savedAt() { return this.#record?.at || 0; }

  /** Pick up the folder chosen on an earlier visit. */
  async load() {
    const record = await this.#kv.get('folder').catch(() => undefined);
    if (!record?.handle || !record.key) return;
    this.#record = record;
    if (await this.#allowed()) this.#set('ok', '', true);
  }

  /** Start saving into `handle`, sealed with `secret` (backupSecret), and save once now. */
  async enable(handle, secret) {
    const { key, salt, iterations } = secret;
    this.#record = { handle, key, salt, iterations, at: 0 };
    await this.#kv.put('folder', this.#record);
    this.#dirty = true;
    this.#set('ok');
    await this.saveNow();
  }

  /** Stop. The files in the folder stay. */
  async disable() {
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#dirty = false;
    this.#record = null;
    await this.#kv.delete('folder').catch(() => {});
    this.#set('off');
  }

  /** Something in the store changed: write soon, once for a burst of changes. */
  markDirty(key) {
    if (!this.#record || !isBackupKey(key)) return;
    this.#dirty = true;
    if (this.#timer) return;
    this.#timer = setTimeout(() => this.flush(), this.#delay);
    this.#timer.unref?.();
  }

  /** Write now if anything changed (the page is being hidden or closed). */
  flush() {
    clearTimeout(this.#timer);
    this.#timer = null;
    return this.#dirty ? this.saveNow() : Promise.resolve();
  }

  saveNow() {
    this.#chain = this.#chain.then(() => this.#write()).catch(() => {});
    return this.#chain;
  }

  /** Ask the browser for the permission again (needs a click); true if now granted. */
  async allow() {
    const handle = this.#record?.handle;
    if (!handle) return false;
    let answer = 'denied';
    try { answer = await handle.requestPermission?.({ mode: 'readwrite' }); } catch { /* denied */ }
    if (answer !== 'granted') {
      this.#set('needs_permission', 'permission refused');
      return false;
    }
    await this.saveNow();
    return this.state === 'ok';
  }

  #set(state, error = '', quiet = false) {
    if (this.state === state && this.error === error) return;
    [this.state, this.error] = [state, error];
    if (!quiet) this.emit('state', state);
  }

  /** Does the browser let us write now? (After a restart it wants a click first.) */
  async #allowed() {
    let answer;
    try { answer = await this.#record.handle.queryPermission?.({ mode: 'readwrite' }); } catch {
      answer = 'denied';
    }
    if (answer === undefined || answer === 'granted') {
      if (this.state === 'needs_permission') this.#set('ok');
      return true;
    }
    this.#set('needs_permission', '');
    return false;
  }

  async #write() {
    const record = this.#record;
    if (!record || !(await this.#allowed())) return;
    try {
      const snapshot = await collect(this.#kv, this.#now());
      // never replace a backup with an empty one (a browser that lost its data starts empty)
      if (!countOf(snapshot).rooms) return;
      await writeFile(record.handle, FOLDER_FILE, await seal(snapshot, record));
      this.#dirty = false;
      record.at = this.#now();
      await this.#kv.put('folder', record).catch(() => {});
      this.#set('ok');
    } catch (err) {
      this.#dirty = true; // the next change, or the next visit, tries again
      this.#set('error', String(err?.name ?? err));
    }
  }
}
