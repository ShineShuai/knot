// Notices when a newer build of the app has been published than the one running. The deploy
// stamps the commit id into index.html (<meta name="build">) and writes build.json
// ({ "build": "<commit>" }); the page compares the two now and then. A static page cannot
// update itself, so the user is asked to reload. Without a stamp (local development, tests) the
// watcher does nothing at all, not even a request: a missing file would be a console error.
// Events: 'update'
import { Emitter } from './util/emitter.js';

const CHECK_EVERY_MS = 15 * 60 * 1000;
const MIN_GAP_MS = 60 * 1000; // coming back to the tab does not hammer the server

export class UpdateWatcher extends Emitter {
  #last = 0; #notified = false;

  /** `running`: the build id stamped into this page, or null when it is not a deploy. */
  constructor({ running = null, fetchJson = defaultFetch, now = Date.now } = {}) {
    super();
    this.running = running || null;
    this.fetchJson = fetchJson;
    this.now = now;
  }

  /** Keep checking (if this page is a stamped build). */
  start() {
    if (!this.running) return;
    const timer = setInterval(() => this.check(), CHECK_EVERY_MS);
    timer.unref?.();
    globalThis.document?.addEventListener?.('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.check();
    });
  }

  /** Compare with what is published now (at most once a minute). */
  async check() {
    if (!this.running || this.#notified || this.now() - this.#last < MIN_GAP_MS) return;
    this.#last = this.now();
    const published = await this.#read();
    if (published && published !== this.running) {
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
