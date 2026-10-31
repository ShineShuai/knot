// LEGACY-CURVES: review and removal plan: LEGACY_CURVES_REVIEW_BY in config.js.
// Curve25519 for the Ed25519 identity and the X25519 sealed boxes. WebCrypto does it where the
// browser has it (Safari 17, Firefox 129, Chrome 137); older ones (iOS 16, which some iPads
// cannot leave) use the bundled TweetNaCl, pure JS. Same wire formats either way. It is
// imported statically, not on demand: it must arrive with the app (flaky networks, offline).
import nacl from '../vendor/nacl-fast.js';

export { nacl };

const USAGES = { Ed25519: ['sign', 'verify'], X25519: ['deriveBits'] };
const probes = new Map();
let forced = false;

async function probe(name) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { // seen once on a freshly started WebKit: the first call failed, the next worked
      await crypto.subtle.generateKey({ name }, false, USAGES[name]);
      return true;
    } catch {
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return false;
}

/** Can WebCrypto do `name` ('Ed25519' or 'X25519')? Asked once per page load. */
export function hasNative(name) {
  if (forced) return Promise.resolve(false);
  if (!probes.has(name)) probes.set(name, probe(name));
  return probes.get(name);
}

/** Let the page draw between two heavy synchronous steps (pure-JS crypto on a slow device). */
export const yieldToUi = () => new Promise((resolve) => {
  const { port1, port2 } = new MessageChannel();
  port1.onmessage = () => { port1.close(); resolve(); };
  port2.postMessage(null);
});

/** For tests: act as if WebCrypto had neither curve. */
export function forceSoftCurves(on = true) {
  forced = on;
  probes.clear();
}
