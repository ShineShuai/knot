// Connectivity probes used by the lab page and for ranking STUN servers.
// A probe asks the browser to gather ICE candidates through a STUN server and
// measures how long the first server-reflexive ("srflx") candidate takes.
const now = () => performance.now();

function gather(iceServers, { timeoutMs, RTC, stopAfterFirst }) {
  return new Promise((resolve) => {
    const t0 = now();
    const found = [];
    const pc = new RTC({ iceServers });
    pc.createDataChannel('probe');
    const finish = (error) => {
      clearTimeout(timer);
      pc.close();
      resolve({ found, ms: Math.round(now() - t0), error });
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    pc.onicecandidate = ({ candidate: c }) => {
      if (!c) return finish(found.length ? undefined : 'no server-reflexive candidate');
      if (c.type === 'srflx') {
        found.push({ mapped: `${c.address}:${c.port}`, ms: Math.round(now() - t0) });
        if (stopAfterFirst) finish();
      }
    };
    pc.createOffer().then((o) => pc.setLocalDescription(o)).catch((e) => finish(String(e)));
  });
}

/** Reachability and latency of one STUN server. */
export async function probeStun(
  url,
  { timeoutMs = 3000, RTC = globalThis.RTCPeerConnection } = {},
) {
  const { found, ms, error } = await gather(
    [{ urls: url }],
    { timeoutMs, RTC, stopAfterFirst: true },
  );
  return found.length ? {
    url,
    ok: true,
    ms: found[0].ms,
    mapped: found[0].mapped,
  } : { url, ok: false, ms, error };
}

/** STUN servers that answered, fastest first. */
export async function rankStun(urls, opts) {
  const results = await Promise.all(urls.map((u) => probeStun(u, opts)));
  return results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);
}

/** Behind a symmetric NAT the same local socket gets a different public port per
 *  destination, so two servers queried from ONE connection report different
 *  mappings. (Separate connections always differ and prove nothing.) */
export async function probeNat(
  urlA,
  urlB,
  { timeoutMs = 4000, RTC = globalThis.RTCPeerConnection } = {},
) {
  const { found } = await gather(
    [{ urls: urlA }, { urls: urlB }],
    { timeoutMs, RTC, stopAfterFirst: false },
  );
  const mappings = new Set(found.map((f) => f.mapped));
  if (!mappings.size) return { type: 'unknown', mappings: [] };
  return { type: mappings.size === 1 ? 'cone' : 'symmetric', mappings: [...mappings] };
}
