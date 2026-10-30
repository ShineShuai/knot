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

/** Options for `<browser>.launch()`. Fake camera and microphone, no permission prompt, and
 *  two pages of one machine may reach each other. Playwright's WebKit takes none of this:
 *  whether it offers capture devices is found out at run time (see run.mjs). */
export function launchOptions(name) {
  if (name === 'chromium') {
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
  if (name === 'firefox') {
    return {
      firefoxUserPrefs: {
        'media.navigator.streams.fake': true,
        'media.navigator.permission.disabled': true,
        'media.peerconnection.ice.loopback': true,
        'media.peerconnection.ice.obfuscate_host_addresses': false,
      },
    };
  }
  return {};
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

/** WebKit shows other pages only a made-up `.local` name instead of the machine's address, and
 *  two pages on one machine cannot look those names up: they need STUN (a real network) to
 *  find each other, like two people on different networks would. */
export const needsStun = (name) => name === 'webkit';

/** Is this a browser that cannot be asked for its fake camera and microphone up front? Its
 *  call checks then run only if the browser turns out to offer capture devices. */
export const needsMediaProbe = (name) => name !== 'chromium';
