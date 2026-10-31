// Curve25519 for the Ed25519 identity and the X25519 sealed boxes. WebCrypto does it where the
// browser has it (Safari 17, Firefox 129, Chrome 137); older ones (iOS 16, which some iPads
// cannot leave) use TweetNaCl, pure JS, fetched only when needed. Same wire formats either way.
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

let loading;
/** TweetNaCl, loaded on first use. */
export function softNacl() {
  loading ??= import('../vendor/nacl-fast.js').then((m) => m.default, (err) => {
    loading = undefined; // offline just now: try again next time
    throw err;
  });
  return loading;
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
