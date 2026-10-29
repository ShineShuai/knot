// Which public MQTT brokers answer, and how fast. Probed once at startup (like STUN, see
// ice-probe.js) and again every few minutes for the ones that failed; real connections that
// succeed report their time too. Channels connect to the fast ones first and retry a broker
// that is known to be down only slowly, instead of hammering it with reconnects.
import { Emitter } from '../util/emitter.js';
import { MqttClient } from './mqtt.js';

const now = () => performance.now();
export const DOWN_RETRY_MS = 60_000; // how long a channel waits before trying a down broker

/** Can we open a WebSocket to the broker and get its MQTT CONNACK? How long did it take? */
export async function probeBroker(url, { timeoutMs = 5000, WS = globalThis.WebSocket } = {}) {
  const t0 = now();
  const client = new MqttClient(url, { WS, connectTimeoutMs: timeoutMs });
  try {
    await client.connect();
    return { url, ok: true, ms: Math.round(now() - t0) };
  } catch (err) {
    return { url, ok: false, ms: Math.round(now() - t0), error: err.message };
  } finally { client.close(); }
}

/** Brokers that answered, fastest first, then the ones that did not (kept: they may return). */
export async function rankBrokers(urls, opts) {
  const results = await Promise.all(urls.map((u) => probeBroker(u, opts)));
  return [...results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms),
    ...results.filter((r) => !r.ok)];
}

/** Events: 'change' (something about a broker's health changed). */
export class BrokerHealth extends Emitter {
  #state = new Map(); // url -> { url, ok, ms, error }
  #timer = null;
  #probe; #recheckMs;

  constructor({ probe = probeBroker, recheckMs = 5 * 60_000 } = {}) {
    super();
    this.#probe = probe;
    this.#recheckMs = recheckMs;
  }

  /** Probe `urls` (a list, or a function returning the current list) now, then re-probe the
   *  brokers that are down every few minutes. */
  start(urls) {
    const list = typeof urls === 'function' ? urls : () => urls;
    this.stop();
    this.check(list());
    this.#timer = setInterval(() => {
      this.check(list().filter((url) => this.isDown(url)));
    }, this.#recheckMs);
    this.#timer.unref?.();
  }

  stop() { clearInterval(this.#timer); this.#timer = null; }

  /** Probe these brokers in parallel; resolves to their rows. */
  async check(urls) {
    const results = await Promise.all(urls.map((url) => this.#probe(url)));
    for (const r of results) this.#state.set(r.url, r);
    if (results.length) this.emit('change');
    return results;
  }

  /** A real connection worked: that is as good as a probe. */
  report(url, ms) {
    const before = this.#state.get(url);
    this.#state.set(url, { url, ok: true, ms });
    if (before?.ok !== true) this.emit('change');
  }

  /** True only for a broker whose probe failed (and that has not connected since). */
  isDown(url) { return this.#state.get(url)?.ok === false; }

  /** `urls` with the fastest first, those not checked yet next, the down ones last. */
  order(urls) {
    const rank = (url) => {
      const s = this.#state.get(url);
      return s?.ok ? s.ms : s ? Infinity : 1e6;
    };
    return urls.map((url, i) => ({ url, i })).sort((a, b) => rank(a.url) - rank(b.url)
      || a.i - b.i).map((x) => x.url);
  }

  /** What to show: { url, ok: true | false | null (not checked), ms, error }. */
  rows(urls) {
    return this.order(urls).map((url) => this.#state.get(url) ?? { url, ok: null });
  }

  /** Resolves after `ms`, or sooner when `url` is reported or found up. */
  untilUp(url, ms) {
    if (!this.isDown(url)) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); off(); resolve(); };
      const off = this.on('change', () => { if (!this.isDown(url)) done(); });
      const timer = setTimeout(done, ms);
      timer.unref?.();
    });
  }
}
