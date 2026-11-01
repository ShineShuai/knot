// Which browser the end-to-end tests run in, and how each one is set up. Pure data and small
// functions, so Node's unit tests can check them without any browser installed.
//   E2E_BROWSER=chromium|firefox|webkit   (default chromium; webkit is Safari's engine)
export const BROWSERS = ['chromium', 'firefox', 'webkit'];

export function browserName(env = process.env) {
  const name = env.E2E_BROWSER || 'chromium';
  if (!BROWSERS.includes(name)) {
    throw new Error(`E2E_BROWSER must be one of ${BROWSERS.join(', ')} (got "${name}")`);
  }
  return name;
}

/** Options for `<browser>.launch()`. Chromium gets a fake camera and microphone and no
 *  permission prompt (the full suite makes calls); Firefox and WebKit run the engine suite,
 *  which needs none. */
export function launchOptions(name) {
  if (name !== 'chromium') return {};
  return {
    args: [
      '--no-sandbox',
      '--allow-loopback-in-peer-connection',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--use-fake-device-for-media-stream', // a test-pattern camera and a beeping microphone
      '--use-fake-ui-for-media-stream', // and no permission prompt
    ],
  };
}

/** Options for `browser.newContext()`. Only Chromium knows the clipboard permissions: the
 *  others refuse a context that asks for them. */
export function contextOptions(name) {
  return {
    serviceWorkers: 'block',
    ...(name === 'chromium' ? { permissions: ['clipboard-read', 'clipboard-write'] } : {}),
  };
}

/** Console lines that are not ours. WebKit's Web Inspector (which Playwright's WebKit has) sets
 *  inline styles from its own script, and WebKit reports them against the page's CSP: the
 *  detailed line names that script (`web-inspector://...`), the plain one cannot name anything.
 *  A violation by one of our files names the file, and still fails the test. */
const WEBKIT_INSPECTOR_CSP = [
  /^Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline'/,
  /^CSP: \S+ blocked \S+ at web-inspector:\/\//,
];

/** Console errors that are expected in a test run: the public brokers cannot be reached from
 *  the sandbox (each browser words that its own way), nobody serves a favicon, and WebKit's
 *  Web Inspector (see above). */
export const isExpectedNoise = (text, name = 'chromium') => (
  /WebSocket|wss?:\/\/|favicon/i.test(text)
  || (name === 'webkit' && WEBKIT_INSPECTOR_CSP.some((re) => re.test(text)))
);

export const SUITES = ['full', 'engine', 'live'];

/** Which checks run. `engine`: those of a single page (the UI, two rooms paired inside one
 *  page, the lab page): they need no camera and no second page, so they run in any browser.
 *  `full` adds real WebRTC between two pages and calls with a fake camera and microphone, which
 *  only Chromium offers. `live`: the few checks that need only the files of a deployed site
 *  (the UI, the lab page), run against E2E_BASE_URL instead of the local server; they are the
 *  smoke test after a deploy, in any browser. Default: live with E2E_BASE_URL, else full in
 *  Chromium and engine elsewhere (E2E_SUITE overrides). */
export function suiteName(env = process.env, name = browserName(env)) {
  const live = Boolean(env.E2E_BASE_URL);
  const suite = env.E2E_SUITE || (live ? 'live' : name === 'chromium' ? 'full' : 'engine');
  if (!SUITES.includes(suite)) {
    throw new Error(`E2E_SUITE must be one of ${SUITES.join(', ')} (got "${suite}")`);
  }
  if (suite === 'full' && name !== 'chromium') {
    throw new Error(
      `The full suite needs Chromium's fake camera and microphone: ${name} runs the engine suite`,
    );
  }
  if (live !== (suite === 'live')) {
    throw new Error('The live suite and E2E_BASE_URL go together: set both or neither');
  }
  return suite;
}
