// Which deploy this page is: the channel and the commit, both stamped into index.html by
// tools/assemble.sh (<meta name="channel">, <meta name="build">). An unstamped page (local
// development, tests) is channel "dev" with no build.

/** `{ channel, build }` of the page; `doc` is the document (a fake or none in tests). */
export function buildInfo(doc = globalThis.document) {
  const meta = (name) => doc?.querySelector?.(`meta[name="${name}"]`)?.content || '';
  return { channel: meta('channel') || 'dev', build: meta('build') };
}

/** The version in the room list: "v0.4.0" on prod and in development, and
 *  "v0.4.0 · beta · abc1234" elsewhere, so a tester always knows which copy this is. */
export function versionLabel(version, { channel, build }) {
  if (channel === 'prod' || channel === 'dev') return `v${version}`;
  return [`v${version}`, channel, build.slice(0, 7)].filter(Boolean).join(' · ');
}

/** The first line of a bug report: "0.4.0 beta abc1234". */
export function versionDetail(version, { channel, build }) {
  return [version, channel, build.slice(0, 7)].filter(Boolean).join(' ');
}
