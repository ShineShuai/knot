// The browser choice and setup of the end-to-end tests (test/e2e/browsers.mjs), and that CI
// runs every browser the runner knows. The browsers themselves are not needed here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BROWSERS, browserName, contextOptions, isExpectedNoise, launchOptions, suiteName,
} from './e2e/browsers.mjs';
import { candidates, loadPlaywright } from './e2e/playwright.mjs';

test('the browser comes from E2E_BROWSER, Chromium by default, and a typo is an error', () => {
  assert.equal(browserName({}), 'chromium');
  assert.equal(browserName({ E2E_BROWSER: '' }), 'chromium');
  for (const name of BROWSERS) assert.equal(browserName({ E2E_BROWSER: name }), name);
  assert.throws(() => browserName({ E2E_BROWSER: 'safari' }), /one of chromium, firefox, webkit/);
});

test('Chromium gets the fake camera and microphone; the engine suite needs nothing', () => {
  assert.ok(launchOptions('chromium').args.includes('--use-fake-device-for-media-stream'));
  assert.deepEqual(launchOptions('firefox'), {});
  assert.deepEqual(launchOptions('webkit'), {});
  assert.deepEqual(contextOptions('chromium').permissions, ['clipboard-read', 'clipboard-write']);
  for (const name of ['firefox', 'webkit']) {
    assert.equal(contextOptions(name).permissions, undefined, `${name} refuses clipboard grants`);
    assert.equal(contextOptions(name).serviceWorkers, 'block');
  }
});

test('the suite: full in Chromium, engine elsewhere, and the full one only in Chromium', () => {
  assert.equal(suiteName({}, 'chromium'), 'full');
  assert.equal(suiteName({}, 'firefox'), 'engine');
  assert.equal(suiteName({}, 'webkit'), 'engine');
  assert.equal(suiteName({ E2E_SUITE: 'engine' }, 'chromium'), 'engine');
  assert.equal(suiteName({ E2E_BROWSER: 'webkit' }), 'engine');
  assert.throws(() => suiteName({ E2E_SUITE: 'full' }, 'webkit'), /fake camera and microphone/);
  assert.throws(() => suiteName({ E2E_SUITE: 'all' }, 'chromium'), /one of full, engine/);
});

test('unreachable brokers are noise in any browser; other errors are not', () => {
  for (const text of [
    "WebSocket connection to 'wss://broker.emqx.io:8084/mqtt' failed: ",
    "Firefox can't establish a connection to the server at wss://broker.hivemq.com:8884/mqtt.",
    'WebSocket network error: The operation couldn\'t be completed.',
    'Failed to load resource: the server responded with a status of 404 (favicon.ico)',
  ]) assert.ok(isExpectedNoise(text), text);
  for (const text of [
    'Uncaught TypeError: Cannot read properties of undefined',
    'Refused to apply inline style because it violates the following Content Security Policy',
  ]) assert.equal(isExpectedNoise(text), false, text);
});

test('CI runs the browser tests in every browser the runner knows, and sets E2E_BROWSER', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const listed = /browser:\s*\[([^\]]+)\]/.exec(ci)[1].split(',').map((x) => x.trim());
  assert.deepEqual(listed, BROWSERS);
  assert.match(ci, /E2E_BROWSER:\s*\$\{\{\s*matrix\.browser\s*\}\}/);
  assert.match(ci, /playwright install --with-deps \$\{\{\s*matrix\.browser\s*\}\}/);
  assert.match(ci, /continue-on-error:\s*\$\{\{\s*matrix\.browser != 'chromium'\s*\}\}/);
});

test('Playwright is looked for in the usual places; a missing one gets a helpful error', () => {
  const where = {
    root: () => '/global/lib', home: '/home/x', exists: () => true, list: () => ['aaa', 'bbb'],
  };
  const npx = (dir) => `/home/x/.npm/_npx/${dir}/node_modules/playwright`;
  assert.deepEqual(candidates({ env: {}, ...where }), [
    'playwright', '/global/lib/playwright', npx('aaa'), npx('bbb'),
  ]);
  assert.equal(candidates({ env: { PLAYWRIGHT_MODULE: '/mine' }, ...where })[0], '/mine');
  assert.ok(!candidates({ env: {}, ...where, root: () => { throw new Error('no npm'); } })
    .some((c) => c.startsWith('/global')));

  const fake = { chromium: {} };
  const load = (spec) => {
    if (spec === '/global/lib/playwright') return fake;
    throw new Error('not found');
  };
  assert.equal(loadPlaywright({ env: { PLAYWRIGHT_MODULE: '…' }, load, ...where }), fake);
  const none = () => { throw new Error('x'); };
  assert.throws(
    () => loadPlaywright({ env: { PLAYWRIGHT_MODULE: '…' }, load: none, ...where }),
    /PLAYWRIGHT_MODULE=… is not a Playwright folder[\s\S]*npm install --no-save playwright/,
  );
});

test('WebKit alone ignores the CSP lines of its own Web Inspector, never one of ours', () => {
  const plain = "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline'";
  const inspector = 'CSP: style-src-attr blocked inline at web-inspector://bootstrap.js:48 '
    + 'after createElement(header) ';
  const ours = 'CSP: style-src-attr blocked inline at http://127.0.0.1:1/src/ui/dom.js:6 '
    + 'after createElement(img) ';
  assert.equal(isExpectedNoise(plain, 'webkit'), true);
  assert.equal(isExpectedNoise(inspector, 'webkit'), true);
  assert.equal(isExpectedNoise(ours, 'webkit'), false, 'a violation of ours must still fail');
  for (const name of ['chromium', 'firefox']) {
    assert.equal(isExpectedNoise(plain, name), false);
    assert.equal(isExpectedNoise(inspector, name), false);
  }
});
