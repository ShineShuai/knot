// One tab per browser profile: every tab of a profile shares one identity and one database, and
// two running at once would clash (the same peer id twice, the room list overwritten, equal
// message stamps). The tab that gets the lock runs; the others show a message instead.

/** Resolves true if this tab now holds the lock (until it closes), false if another tab does.
 *  A few short retries first: on a reload the old page may take a moment to let go. Where Web
 *  Locks are missing (old browsers, plain http) nothing is enforced. */
export async function holdInstance(
  locks = globalThis.navigator?.locks, name = 'knot-instance', { retries = 3, delay = 250 } = {},
) {
  if (!locks?.request) return true;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (await tryHold(locks, name)) return true;
    if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return false;
}

const tryHold = (locks, name) => new Promise((resolve) => {
  locks.request(name, { ifAvailable: true }, (lock) => {
    resolve(!!lock);
    return lock ? new Promise(() => {}) : undefined; // held until the tab goes away
  }).catch(() => resolve(true)); // a broken implementation must never lock people out
});
