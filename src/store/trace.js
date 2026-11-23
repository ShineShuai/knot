// Notes for the diagnostics report about lost data. When the browser wipes the site's data, the
// app just starts again as a new user, and a "last active" time stored before is gone with the
// rest. What can be kept: when the new identity was made, and, if the browser closed the
// database under a running page and it came back empty, when that happened.
const MINUTE = 60_000;

/** A new identity was just made. */
export const noteBorn = (kv, now = Date.now()) => kv.put('born', now);

/** The browser closed our connection to the database: if the identity is gone, it was wiped. */
export async function noteLoss(kv, now = Date.now()) {
  if ((await kv.get('identity')) === undefined) await kv.put('lost', now);
}

const span = (ms) => {
  const min = Math.max(0, Math.round(ms / MINUTE));
  if (min < 120) return `${min} min`;
  return min < 2880 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} days`;
};
const when = (at, now) => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`
  + ` (${span(now - at)} ago)`;

/** Report lines: when this identity was made, and when the data was wiped under a live page. */
export async function traceLines(kv, now = Date.now()) {
  try {
    const [born, lost] = [await kv.get('born'), await kv.get('lost')];
    return [
      `identity created: ${Number.isFinite(born) ? when(born, now) : 'unknown (older version)'}`,
      ...(Number.isFinite(lost) ? [`data wiped under a running page: ${when(lost, now)}`] : []),
    ];
  } catch (err) { return [`identity created: unreadable (${err.name})`]; }
}
