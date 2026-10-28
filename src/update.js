// Notices when a newer build of the app has been published than the one running. The deploy
// writes build.json ({ "build": "<commit>" }); the page reads it once at start and again now and
// then. A static page cannot update itself, so the user is asked to reload. Where build.json does
// not exist (local development) nothing ever fires.
// Events: 'update'
import { Emitter } from './util/emitter.js';

const CHECK_EVERY_MS = 15 * 60 * 1000;
const MIN_GAP_MS = 60 * 1000; // coming back to the tab does not hammer the server

export class UpdateWatcher extends Emitter {
  #running = null; #last = 0; #notified = false;

  constructor({ fetchJson = defaultFetch, now = Date.now } = {}) {
    super();
    this.fetchJson = fetchJson;
    this.now = now;
  }

  /** Learn which build is running, then keep checking. */
  async start() {
    this.#running = await this.#read();
    const timer = setInterval(() => this.check(), CHECK_EVERY_MS);
    timer.unref?.();
    globalThis.document?.addEventListener?.('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.check();
    });
  }

  /** Compare with what is published now (at most once a minute). */
  async check() {
    if (!this.#running || this.#notified || this.now() - this.#last < MIN_GAP_MS) return;
    this.#last = this.now();
    const published = await this.#read();
    if (published && published !== this.#running) {
      this.#notified = true;
      this.emit('update');
    }
  }

  async #read() {
    try {
      const { build } = await this.fetchJson('build.json');
      return typeof build === 'string' && build ? build : null;
    } catch { return null; } // offline, or no build.json: nothing to compare
  }
}

async function defaultFetch(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
