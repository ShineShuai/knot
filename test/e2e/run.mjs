// End-to-end tests in real browsers (real WebRTC, real IndexedDB, real UI).
//   node test/e2e/run.mjs                      Chromium, the full suite
//   E2E_BROWSER=firefox|webkit node ...        that browser, the engine suite (WebKit is Safari's)
// The engine suite is the checks of a single page; the full suite adds two pages, and calls with
// a fake camera and microphone, which only Chromium offers (see browsers.mjs).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startServer } from '../../tools/serve.mjs';
import {
  browserName, contextOptions, isExpectedNoise, launchOptions, suiteName,
} from './browsers.mjs';
import { loadPlaywright } from './playwright.mjs';

const NAME = browserName();
const SUITE = suiteName(process.env, NAME);
const playwright = loadPlaywright();
// E2E_BASE_URL: test a deployed site (the live suite) instead of the files of this checkout.
const BASE_URL = process.env.E2E_BASE_URL?.replace(/\/+$/, '') || null;
const server = BASE_URL ? null : await startServer(0);
const base = BASE_URL ?? `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await playwright[NAME].launch(launchOptions(NAME));
} catch (err) {
  server?.close();
  if (/profile folder/.test(String(err))) {
    console.log(`${NAME} does not start with Playwright's temporary profile (not the app).\n`
      + `Try another Node (this is ${process.version}; 22 or 24), then `
      + `\`npx playwright install --force ${NAME}\`.`);
  }
  if (process.env.E2E_SKIP_MISSING && /Executable doesn't exist/.test(String(err))) {
    console.log(`skip ${NAME}: not installed (npx playwright install ${NAME})`);
    process.exit(0);
  }
  if (process.env.E2E_SKIP_MISSING && /profile folder/.test(String(err))) {
    console.log(`skip ${NAME}: does not start on this machine (see above); CI runs it`);
    process.exit(0);
  }
  throw err;
}
console.log(`browser: ${NAME} ${browser.version()}, ${SUITE} suite`);
const failures = [];
/** Init script: the microphone is a steady tone. The fake device only beeps for 20 ms a second,
 *  which the browser's own noise filter may swallow; a tone from Web Audio is not filtered. */
const toneMicrophone = () => {
  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const stream = await real(constraints);
    if (!stream.getAudioTracks().length) return stream;
    const ctx = new AudioContext();
    const oscillator = ctx.createOscillator();
    const destination = ctx.createMediaStreamDestination();
    oscillator.connect(destination);
    oscillator.start();
    // An audio context may wait for a gesture: the tone then stays silent, and the call must
    // not wait for it.
    await Promise.race([ctx.resume(), new Promise((resolve) => setTimeout(resolve, 300))]);
    for (const track of stream.getAudioTracks()) { track.stop(); stream.removeTrack(track); }
    stream.addTrack(destination.stream.getAudioTracks()[0]);
    return stream;
  };
};
/** A check of the full suite. E2E_ONLY=<part of a name> runs just that one. */
async function check(name, fn, { single = false, live = false } = {}) {
  if (process.env.E2E_ONLY && !name.includes(process.env.E2E_ONLY)) return;
  if (SUITE === 'engine' && !single) return;
  if (SUITE === 'live' && !live) return; // the live suite: only what a deployed site can serve
  livePages.clear();
  try { await fn(); console.log(`ok   ${name}`); } catch (err) {
    failures.push(name);
    console.log(`FAIL ${name}\n     ${err.stack ?? err}`);
    await dumpRtc();
  }
}
/** A check of a single page: it is also part of the engine suite, which runs in any browser.
 *  With `live`, it needs only the files of the site (no test/ pages): the live suite runs it. */
const single = (name, fn, options) => check(name, fn, { single: true, ...options });
const livePages = new Set(); // the pages of the running check
async function dumpRtc() { // the ICE log of each page: why two pages did not connect
  for (const [i, page] of [...livePages].entries()) {
    const lines = await page.evaluate(() => (window.__rtc ?? []).slice(-24)).catch(() => []);
    if (lines.length) console.log(`     ICE log of page ${i}:\n       ${lines.join('\n       ')}`);
  }
}
const newPage = async () => {
  const context = await browser.newContext(contextOptions(NAME));
  const page = await context.newPage();
  // What a blocked resource was (the browsers' own CSP messages do not say), and what ICE did
  // (for the log of a failed check).
  await page.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    if (Native) { // what ICE did, for the log of a failed check
      window.__rtc = [];
      const log = (text) => window.__rtc.push(`${Math.round(performance.now())} ${text}`);
      window.RTCPeerConnection = class extends Native {
        constructor(...args) {
          super(...args);
          const id = Math.random().toString(36).slice(2, 5);
          log(`pc ${id} created, ${args[0]?.iceServers?.length ?? 0} ICE servers`);
          this.addEventListener('icecandidate', (e) => log(
            `pc ${id} candidate ${e.candidate ? e.candidate.candidate : '(end)'}`));
          for (const type of ['iceconnectionstatechange', 'connectionstatechange']) {
            this.addEventListener(type, () => log(
              `pc ${id} ${type.replace('statechange', '')} `
              + `${this.iceConnectionState}/${this.connectionState}`));
          }
        }
      };
    }
    const create = document.createElement.bind(document);
    let lastTag = ''; // the element being made when a violation is reported (they are sync)
    document.createElement = (tag, options) => {
      lastTag = String(tag);
      return create(tag, options);
    };
    document.addEventListener('securitypolicyviolation', (e) => console.error(
      `CSP: ${e.violatedDirective} blocked ${e.blockedURI || '(inline)'} `
      + `at ${e.sourceFile}:${e.lineNumber} after createElement(${lastTag}) `
      + `${(e.sample || '').slice(0, 80)}`,
    ));
  });
  livePages.add(page);
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  // Public brokers are unreachable in offline test runs; that console noise is expected.
  page.on(
    'console',
    (m) => m.type() === 'error' && !isExpectedNoise(m.text(), NAME) && page.errors.push(m.text()),
  );
  return page;
};

// ---- 1. Real WebRTC through the Room API (manual pairing, chat, history, files) --------------
await check('manual pairing, chat and file transfer over real WebRTC', async () => {
  const [a, b] = [await newPage(), await newPage()];
  await Promise.all([a, b].map((p) => p.goto(`${base}/test/e2e/blank.html`)));
  const boot = ({ name, secretB64 }) => async ({ name, secretB64 }) => {
    const { Room } = await import('/src/chat/room.js');
    const { DEFAULTS } = await import('/src/config.js');
    const { MemoryKV } = await import('/src/store/kv.js');
    const { loadIdentity } = await import('/src/crypto/identity.js');
    const { newRoomSecret } = await import('/src/crypto/room-keys.js');
    const { fromB64u } = await import('/src/util/bytes.js');
    const kv = new MemoryKV();
    window.room = await Room.open({
      identity: await loadIdentity(kv), secret: secretB64 ? fromB64u(
        secretB64,
      ) : newRoomSecret(), label: name, kv,
      settings: {
        ...DEFAULTS,
        name,
        brokersEnabled: false,
        gatherTimeoutMs: 1500,
      }, iceServers: () => [],
    });
  };
  await a.evaluate(boot({}), { name: 'Ada' });
  const code = await a.evaluate(async () => (await window.room.createInvite()).code);
  assert.match(code, /^knot1-/);
  const secretB64 = await b.evaluate(async (c) => {
    const { decodeCode } = await import('/src/net/handshake.js');
    const { toB64u } = await import('/src/util/bytes.js');
    return toB64u(decodeCode(c).roomSecret);
  }, code);
  await b.evaluate(boot({}), { name: 'Bob', secretB64 });
  const reply = await b.evaluate(async (c) => {
    const { decodeCode } = await import('/src/net/handshake.js');
    return window.room.answerOffer(decodeCode(c));
  }, code);
  await a.evaluate(async (c) => {
    const { decodeCode } = await import('/src/net/handshake.js');
    await window.room.acceptAnswer(decodeCode(c));
  }, reply.code);
  for (const p of [a, b]) await p.waitForFunction(
    () => window.room.peerList.some((x) => x.state === 'p2p'),
    null,
    { timeout: 15000 },
  );
  assert.equal(await a.evaluate(() => window.room.peerList[0].sas), reply.sas);

  await a.evaluate(() => window.room.sendText('hello from Ada'));
  await b.evaluate(() => window.room.sendText('hello from Bob'));
  for (const p of [a, b]) await p.waitForFunction(() => window.room.log.size === 2);

  const size = 300_000;
  const bytes = Buffer.from(Array.from({ length: size }, (_, i) => (i * 7 + (i >> 8)) % 256));
  await a.evaluate(async (n) => {
    const data = Uint8Array.from({ length: n }, (_, i) => (i * 7 + (i >> 8)) % 256);
    await window.room.shareFile(new File([data], 'data.bin'));
  }, size);
  await b.waitForFunction(() => window.room.log.list().some((e) => e.kind === 'file'));
  const got = await b.evaluate(async () => {
    const env = window.room.log.list().find((e) => e.kind === 'file');
    const blob = await window.room.downloadFile(env);
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return {
      size: blob.size,
      hex: [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join(''),
    };
  });
  assert.equal(got.size, size);
  assert.equal(got.hex, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual([...a.errors, ...b.errors], []);
  await Promise.all([a, b].map((p) => p.context().close()));
});

// ---- 2. UI smoke: create a room, chat, reload, data persists
// --------------------------------------
await single('UI: create room, send message, persists after reload', async () => {
  const page = await newPage();
  await page.goto(`${base}/index.html`);
  await page.getByRole('button', { name: 'New room' }).click();
  await page.getByRole('button', { name: 'Create room' }).click(); // nothing exists before this
  await page.getByRole('button', { name: 'I saved it' }).click(); // the recovery code comes first
  await page.locator('dialog').waitFor();
  assert.match(
    await page.locator('dialog .copy-field textarea').first().inputValue(),
    /#j=[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{11}$/, // an owned room is joined through its owner
  );
  await page.keyboard.press('Escape');
  await page.getByPlaceholder('Write a message').fill('first words');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.locator('.msg.own', { hasText: 'first words' }).waitFor();
  await page.reload();
  await page.locator('.room-item').click();
  await page.locator('.msg.own', { hasText: 'first words' }).waitFor();
  assert.deepEqual(page.errors, []);
  await page.context().close();
}, { live: true });

// ---- 3. UI manual pairing between two browsers
// ------------------------------------------------------
await check('UI: pair two browsers with codes, chat both ways, share a file', async () => {
  const [a, b] = [await newPage(), await newPage()];
  await b.addInitScript(toneMicrophone); // Bob "speaks" all the time
  await Promise.all([a, b].map((p) => p.goto(`${base}/index.html`)));
  await a.getByRole('button', { name: 'New room' }).click();
  await a.getByRole('button', { name: 'Create room' }).click();
  assert.match(await a.locator('dialog textarea').inputValue(), /^knot-rk1-/);
  await a.getByRole('button', { name: 'I saved it' }).click();
  await a.getByRole('button', { name: 'Create pairing code' }).click();
  const offer = await a.locator('dialog .pair .copy-field textarea').inputValue();
  assert.match(offer, /^knot1-/);
  assert.ok(await a.locator('dialog svg.qr').count() === 1, 'QR is shown');

  await b.getByRole('button', { name: 'Join' }).click();
  await b.getByPlaceholder('Link or code').fill(offer);
  await b.locator('dialog').getByRole('button', { name: 'Join' }).click();
  const reply = await b.locator('dialog .pair .copy-field textarea').inputValue();
  assert.match(reply, /^knot1-/);
  const sasB = await b.locator('dialog strong.sas').textContent();

  await a.getByPlaceholder('Paste the reply code').fill(reply);
  await a.locator('dialog').getByRole('button', { name: 'Connect' }).click();
  // the entry of the other device, not our own
  for (const p of [a, b]) await p.locator('.peer.p2p:not(.me)').waitFor({ timeout: 15000 });
  assert.equal(await a.locator('dialog strong.sas').textContent(), sasB);

  for (const p of [a, b]) await p.keyboard.press('Escape');
  await a.getByPlaceholder('Write a message').fill('hi Bob 你好');
  await a.getByRole('button', { name: 'Send' }).click();
  await b.locator('.msg.other', { hasText: 'hi Bob 你好' }).waitFor();
  await b.getByPlaceholder('Write a message').fill('hi Ada');
  await b.keyboard.press('Enter');
  await a.locator('.msg.other', { hasText: 'hi Ada' }).waitFor();

  await a.locator('input[type=file]').setInputFiles(
    { name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('file over p2p') },
  );
  await a.locator('.chip', { hasText: 'note.txt' }).waitFor(); // staged, not yet sent
  assert.equal(await b.locator('.file', { hasText: 'note.txt' }).count(), 0);
  await a.getByRole('button', { name: 'Send' }).click();
  await b.locator('.file', { hasText: 'note.txt' }).waitFor();
  await b.locator('.file button').click();
  const [download] = await Promise.all(
    [b.waitForEvent('download'), b.locator('.file a', { hasText: 'Save' }).click()],
  );
  assert.equal(download.suggestedFilename(), 'note.txt');

  // An image: the thumbnail comes with the message, the preview follows, the original not.
  const noise = await a.evaluate(async () => {
    const canvas = document.createElement('canvas');
    [canvas.width, canvas.height] = [1200, 800];
    const ctx = canvas.getContext('2d');
    const rnd = () => Math.floor(Math.random() * 256);
    for (let y = 0; y < 800; y += 2) {
      for (let x = 0; x < 1200; x += 2) {
        ctx.fillStyle = `rgb(${rnd()},${rnd()},${rnd()})`;
        ctx.fillRect(x, y, 2, 2);
      }
    }
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return btoa(binary);
  });
  await a.locator('input[type=file]').setInputFiles(
    { name: 'noise.png', mimeType: 'image/png', buffer: Buffer.from(noise, 'base64') },
  );
  await a.getByRole('button', { name: 'Send' }).click();
  await b.locator('.imgcard').waitFor();
  await b.waitForFunction(() => {
    const img = document.querySelector('.imgcard img');
    return img && !img.classList.contains('low') && img.complete && img.naturalWidth > 160;
  });
  assert.match(await b.locator('.imgcard .imgact button').textContent(), /Original/);
  // The card has its size and shape (it collapsed to nothing in Safari when styles were blocked).
  const shown = await b.locator('.imgcard img').boundingBox();
  assert.ok(shown.width >= 100 && shown.height >= 60, `image card ${shown.width}x${shown.height}`);
  const shape = shown.width / shown.height;
  assert.ok(Math.abs(shape - 1200 / 800) < 0.05, `the image card has its shape (${shape})`);

  // Paste a clipboard file into the composer, then drop two files on the chat.
  // (A plain Event with the data attached: Firefox and WebKit ignore it in the constructors.)
  await a.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(['pasted'], 'pasted.txt', { type: 'text/plain' }));
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: data });
    document.querySelector('.composer textarea').dispatchEvent(event);
  });
  await a.locator('.chip', { hasText: 'pasted.txt' }).waitFor(); // staged in the message box
  assert.equal(await b.locator('.file', { hasText: 'pasted.txt' }).count(), 0);
  await a.keyboard.press('Enter'); // the box has focus after a paste
  await b.locator('.file', { hasText: 'pasted.txt' }).waitFor();
  await a.evaluate(() => {
    const data = new DataTransfer();
    for (const name of ['drop1.txt', 'drop2.txt']) data.items.add(new File([name], name));
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: data });
    document.querySelector('.stage').dispatchEvent(event);
  });
  await a.locator('.chip').nth(1).waitFor();
  await a.locator('.chip', { hasText: 'drop1.txt' }).getByRole('button').click(); // remove one
  await a.getByRole('button', { name: 'Send' }).click();
  await b.locator('.file', { hasText: 'drop2.txt' }).waitFor();
  assert.equal(await b.locator('.file', { hasText: 'drop1.txt' }).count(), 0);
  // The message box grows with its text, but stays capped.
  await a.locator('.composer textarea').fill(Array(30).fill('line').join('\n'));
  const box = await a.locator('.composer textarea').evaluate((el) => el.offsetHeight);
  assert.ok(box > 40 && box < 300, `textarea height ${box}`);
  await a.locator('.composer textarea').fill('');

  // Quote a message, see connection details while V is held, delete a message.
  const hello = b.locator('.msg', { hasText: 'hi Bob 你好' });
  await hello.hover();
  await hello.getByRole('button', { name: 'Reply' }).click();
  await b.keyboard.type('quoted answer');
  await b.keyboard.press('Enter');
  await a.locator('.quote', { hasText: 'hi Bob 你好' }).waitFor();
  await a.locator('body').click({ position: { x: 1, y: 1 } }); // leave the message box
  await a.keyboard.down('v');
  await a.locator('.conninfo', { hasText: /anon-[\w-]+ \(direct/ }).waitFor();
  await a.keyboard.up('v');
  await a.locator('.conninfo').waitFor({ state: 'hidden' });
  a.once('dialog', (dialog) => dialog.accept());
  const mine = a.locator('.msg.own', { hasText: 'hi Bob 你好' });
  await mine.hover();
  await mine.getByRole('button', { name: 'Delete' }).click();
  await b.locator('.msg.gone', { hasText: /anon-[\w-]+ deleted a message/ }).waitFor();
  await b.locator('.quote.gone', { hasText: 'Deleted message' }).waitFor();

  // The creator owns the room: the member list says so, and offers owner actions.
  await a.getByRole('button', { name: 'Members' }).click();
  await a.locator('.member .badge', { hasText: 'owner' }).waitFor();
  await a.locator('.member').nth(1).getByRole('button', { name: 'Remove' }).waitFor();
  await a.keyboard.press('Escape');
  await b.getByRole('button', { name: 'Members' }).click();
  assert.equal(await b.getByRole('button', { name: 'Remove' }).count(), 0); // only the owner
  await b.keyboard.press('Escape');
  // Links and more reactions in the real page.
  await b.getByPlaceholder('Write a message').fill('docs https://example.com/a?b=1, thanks');
  await b.keyboard.press('Enter');
  const docs = a.locator('.msg.other', { hasText: 'docs https' });
  await docs.waitFor();
  assert.equal(await docs.locator('a.link').getAttribute('href'), 'https://example.com/a?b=1');
  assert.equal(await docs.locator('a.link').getAttribute('target'), '_blank');
  assert.match(await docs.locator('a.link').getAttribute('rel'), /noopener/);
  await docs.hover();
  await docs.getByRole('button', { name: 'React' }).click();
  await docs.getByRole('button', { name: 'More emoji' }).click();
  const grid = await docs.locator('.palette-grid').boundingBox();
  const bubble = await docs.boundingBox();
  assert.ok(grid.height <= 170 && grid.x + grid.width <= bubble.x + bubble.width + 1, 'fits');
  await docs.locator('.pick', { hasText: '🎉' }).click();
  await b.locator('.rx', { hasText: '🎉 1' }).waitFor();

  // Text and files during a call, with the real layout: desktop width, then a phone.
  const reachable = (sel) => a.locator(sel).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return el === hit || el.contains(hit);
  });
  // Settings: broker status (probed at startup), diagnostics report, storage line.
  await a.getByRole('button', { name: 'Settings' }).click();
  await a.waitForFunction(() => document.querySelectorAll('.broker-health li').length === 3
    && [...document.querySelectorAll('.broker-health li')]
      .every((li) => !li.textContent.startsWith('…')),
  null, { timeout: 20000 });
  await a.getByRole('button', { name: 'Diagnostics' }).click();
  await a.locator('dialog h2', { hasText: 'Diagnostics' }).waitFor();
  const report = await a.locator('dialog textarea').inputValue();
  assert.match(report, /^knot \d/);
  assert.match(report, /WebCrypto Ed25519: yes/);
  assert.match(report, /room \S+: peers \[p2p/);
  await a.keyboard.press('Escape');

  const call = a.locator('section.call');
  await a.getByRole('button', { name: 'Start an audio call' }).click();
  await a.locator('.call .tile').waitFor();
  await b.locator('.call-banner button').click(); // Bob joins: both are shown, camera or not
  await a.locator('.call .tile').nth(1).waitFor();
  // Bob's microphone is a tone: his tile gets the speaking outline on Ada's screen.
  await a.locator('.call .tile:not(.self).speaking').waitFor({ timeout: 15000 });
  const fits = () => a.locator('.call-grid').evaluate((grid) => {
    const g = grid.getBoundingClientRect();
    return grid.scrollHeight <= grid.clientHeight + 1 && [...grid.children].every((tile) => {
      const r = tile.getBoundingClientRect();
      return r.width > 40 && r.height > 40 && r.left >= g.left - 1 && r.right <= g.right + 1
        && r.bottom <= g.bottom + 1;
    });
  });
  assert.ok(await fits(), 'both tiles fit in the full window');
  const view = a.viewportSize();
  let at = await call.boundingBox();
  assert.ok(at.width >= view.width - 1 && at.height >= view.height - 1, 'full screen at first');
  await call.getByRole('button', { name: 'Show chat' }).click();
  at = await call.boundingBox();
  const beside = await a.locator('.stage').boundingBox();
  assert.ok(at.x > 0 && Math.abs(at.x + at.width - view.width) <= 1, 'the call is at the side');
  assert.ok(beside.x + beside.width <= at.x + 1, 'the conversation is beside it, not under it');
  assert.ok(await reachable('.composer textarea'));
  assert.ok(await fits(), 'both tiles fit beside the conversation');
  await a.getByPlaceholder('Write a message').fill('typing during the call');
  await a.keyboard.press('Enter');
  await b.locator('.msg.other', { hasText: 'typing during the call' }).waitFor();
  await a.locator('input[type=file]').setInputFiles(
    { name: 'during.txt', mimeType: 'text/plain', buffer: Buffer.from('sent in a call') },
  );
  await a.getByRole('button', { name: 'Send' }).click();
  await b.locator('.file', { hasText: 'during.txt' }).waitFor();

  await a.setViewportSize({ width: 390, height: 800 }); // a phone: the call on top
  at = await call.boundingBox();
  const below = await a.locator('.stage').boundingBox();
  assert.ok(at.y <= 1 && at.width >= 389, 'the call is on top');
  assert.ok(await fits(), 'both tiles fit in the strip above the conversation');
  assert.ok(below.y >= at.y + at.height - 1, 'the conversation is below it');
  assert.ok(await reachable('.composer textarea'));
  const wide = await a.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(wide <= 0, `sideways overflow ${wide}px`);
  await call.getByRole('button', { name: 'Minimize' }).click(); // a bar: must not cover the box
  at = await call.boundingBox();
  const composer = await a.locator('.composer').boundingBox();
  assert.ok(composer.y + composer.height <= at.y + 1, 'the bar does not cover the message box');
  assert.ok(await reachable('.composer textarea'));
  await call.getByRole('button', { name: 'Leave call' }).click();
  await call.waitFor({ state: 'hidden' });

  assert.deepEqual([...a.errors, ...b.errors], []);
  await Promise.all([a, b].map((p) => p.context().close()));
});

// ---- 3b. Audio/video call over real WebRTC (fake camera and microphone) ---------------------
/** Two blank pages, each with a Room in `window.room`, paired by code over real WebRTC. */
async function pairedRooms() {
  const [a, b] = [await newPage(), await newPage()];
  await Promise.all([a, b].map((p) => p.goto(`${base}/test/e2e/blank.html`)));
  const open = async ({ name, secretB64 }) => {
    const { Room } = await import('/src/chat/room.js');
    const { DEFAULTS } = await import('/src/config.js');
    const { MemoryKV } = await import('/src/store/kv.js');
    const { loadIdentity } = await import('/src/crypto/identity.js');
    const { newRoomSecret } = await import('/src/crypto/room-keys.js');
    const { fromB64u } = await import('/src/util/bytes.js');
    const kv = new MemoryKV();
    window.room = await Room.open({
      identity: await loadIdentity(kv), label: name, kv, iceServers: () => [],
      secret: secretB64 ? fromB64u(secretB64) : newRoomSecret(),
      settings: { ...DEFAULTS, name, brokersEnabled: false, gatherTimeoutMs: 1500 },
    });
  };
  await a.evaluate(open, { name: 'Ada' });
  const code = await a.evaluate(async () => (await window.room.createInvite()).code);
  const secretB64 = await b.evaluate(async (c) => {
    const { decodeCode } = await import('/src/net/handshake.js');
    const { toB64u } = await import('/src/util/bytes.js');
    return toB64u(decodeCode(c).roomSecret);
  }, code);
  await b.evaluate(open, { name: 'Bob', secretB64 });
  const reply = await b.evaluate(async (c) => {
    const { decodeCode } = await import('/src/net/handshake.js');
    return window.room.answerOffer(decodeCode(c));
  }, code);
  await a.evaluate(async (c) => {
    const { decodeCode } = await import('/src/net/handshake.js');
    await window.room.acceptAnswer(decodeCode(c));
  }, reply.code);
  for (const p of [a, b]) await p.waitForFunction(
    () => window.room.peerList.some((x) => x.state === 'p2p'), null, { timeout: 15000 },
  );
  return [a, b];
}

await check('audio/video call: media flows both ways, mute and camera, leave', async () => {
  const [a, b] = await pairedRooms();
  const joined = await Promise.all(
    [a, b].map((p) => p.evaluate(() => window.room.call.join({ video: true }))),
  );
  assert.deepEqual(joined, [{ audio: true, video: true }, { audio: true, video: true }]);
  // Play the other side's stream in a <video>: decoded frames prove media really arrives.
  const framesDecoded = (p) => p.evaluate(async () => {
    // Frames shown so far: counted with requestVideoFrameCallback (Chromium, Firefox and
    // WebKit all have it; their own decoded-frame counters differ for streams).
    window.framesOf ??= (v) => (v.requestVideoFrameCallback ? window.frames
      : v.getVideoPlaybackQuality().totalVideoFrames);
    if (!window.probe) {
      const [{ stream }] = window.room.call.participants;
      window.probe = Object.assign(document.createElement('video'), { muted: true });
      window.probe.srcObject = stream;
      document.body.append(window.probe);
      window.frames = 0;
      const count = () => { window.frames++; window.probe.requestVideoFrameCallback(count); };
      window.probe.requestVideoFrameCallback?.(count);
      await window.probe.play();
    }
    return window.framesOf(window.probe);
  });
  for (const p of [a, b]) {
    await p.waitForFunction(
      () => window.room.call.participants[0]?.state === 'connected', null, { timeout: 20000 },
    );
    const first = await framesDecoded(p);
    await p.waitForFunction(
      (n) => window.framesOf(window.probe) > n + 5, first,
      { timeout: 15000 },
    );
    assert.equal(
      await p.evaluate(() => window.room.call.participants[0].stream.getAudioTracks().length),
      1,
    );
  }
  await a.evaluate(() => window.room.call.setAudio(false));
  await b.waitForFunction(() => [...window.room.call.members.values()][0].a === false);
  await a.evaluate(() => window.room.call.setVideo(false));
  await b.waitForFunction(() => [...window.room.call.members.values()][0].v === false);
  await a.evaluate(() => window.room.call.setVideo(true)); // new camera capture, same connection
  await b.waitForFunction(() => [...window.room.call.members.values()][0].v === true);
  const before = await framesDecoded(b);
  await b.waitForFunction(
    (n) => window.framesOf(window.probe) > n + 5, before,
    { timeout: 15000 },
  );
  await a.evaluate(() => window.room.call.leave());
  await b.waitForFunction(() => window.room.call.participants.length === 0);
  assert.deepEqual([...a.errors, ...b.errors], []);
  await Promise.all([a, b].map((p) => p.context().close()));
});

// ---- 3c. The engine itself: two rooms in ONE page (no second page to find, so this runs in
// every browser, WebKit included). Every step is tried and reported, so one run shows
// everything that does not work in a browser, not just the first thing.
await single('two rooms in one page: text, edit, reaction, image, delete', async () => {
  const page = await newPage();
  await page.goto(`${base}/test/e2e/blank.html`);
  const results = await page.evaluate(async () => {
    const results = [];
    const step = async (name, fn) => {
      try { results.push({ name, ok: true, detail: (await fn()) ?? '' }); } catch (err) {
        results.push({ name, ok: false, detail: `${err?.name}: ${err?.message}` });
      }
    };
    const until = async (fn, ms = 20000) => {
      const t0 = performance.now();
      while (!fn()) {
        if (performance.now() - t0 > ms) throw new Error('timed out');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    const { Room } = await import('/src/chat/room.js');
    const { DEFAULTS } = await import('/src/config.js');
    const { MemoryKV } = await import('/src/store/kv.js');
    const { loadIdentity } = await import('/src/crypto/identity.js');
    const { decodeCode } = await import('/src/net/handshake.js');
    const open = async (name, secret) => {
      const kv = new MemoryKV();
      return Room.open({
        identity: await loadIdentity(kv), label: name, kv, iceServers: () => [], secret,
        settings: { ...DEFAULTS, name, brokersEnabled: false, imagePreviews: 'auto',
          gatherTimeoutMs: 1500 },
      });
    };
    const find = (room, id) => room.log.timeline().find((e) => e.id === id);
    let a; let b;
    await step('pair two rooms with a code', async () => {
      const { newRoomSecret } = await import('/src/crypto/room-keys.js');
      a = await open('Ada', newRoomSecret());
      const { code } = await a.createInvite();
      b = await open('Bob', decodeCode(code).roomSecret);
      const reply = await b.answerOffer(decodeCode(code));
      await a.acceptAnswer(decodeCode(reply.code));
      await until(() => [a, b].every((r) => r.peerList.some((p) => p.state === 'p2p')));
    });
    if (!results[0].ok) return results;
    let hello;
    await step('text arrives', async () => {
      hello = await a.sendText('hello Bob');
      await until(() => b.log.has(hello.id));
    });
    await step('edit arrives', async () => {
      await a.editMessage(hello.id, 'hello Bob (edited)');
      await until(() => b.log.textOf(find(b, hello.id)) === 'hello Bob (edited)');
    });
    await step('reaction arrives', async () => {
      await b.react(hello.id, '👍');
      await until(() => a.log.overlay().reactions.get(hello.id)?.has('👍'));
    });
    const noise = new File(['x'], 'x'); // replaced below; keeps `file` defined if the step fails
    let file = noise;
    let shared;
    await step('image: the sender makes thumbnail and preview', async () => {
      const canvas = document.createElement('canvas');
      [canvas.width, canvas.height] = [1200, 800];
      const context = canvas.getContext('2d');
      const pixels = context.createImageData(1200, 800);
      for (let i = 0; i < pixels.data.length; i += 4) {
        pixels.data[i] = (i * 7) & 255;
        pixels.data[i + 1] = (i * 13) & 255;
        pixels.data[i + 2] = (i * 29) & 255;
        pixels.data[i + 3] = 255;
      }
      context.putImageData(pixels, 0, 0);
      const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      file = new File([png], 'noise.png', { type: 'image/png' });
      shared = await a.shareFile(file);
      if (!shared.body.img) throw new Error('no thumbnail: the image went as a plain file');
      return `${shared.body.img.w}x${shared.body.img.h}, ${Object.keys(shared.body.img).join(',')}`;
    });
    await step('image: the other side fetches the preview', async () => {
      await until(() => b.log.has(shared.id));
      const blob = await b.previewBlob(find(b, shared.id));
      if (!blob?.size) throw new Error('no preview came');
      const bitmap = await createImageBitmap(blob);
      return `${blob.type}, ${blob.size} bytes, ${bitmap.width}x${bitmap.height}`;
    });
    await step('image: the original downloads', async () => {
      const blob = await b.downloadFile(find(b, shared.id));
      if (blob.size !== file.size) throw new Error(`${blob.size} bytes instead of ${file.size}`);
    });
    await step('delete arrives', async () => {
      await a.deleteMessage(hello.id);
      await until(() => b.log.isGone(hello.id));
    });
    return results;
  });
  for (const { ok, name, detail } of results) {
    console.log(`     ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  }
  assert.deepEqual(results.filter((r) => !r.ok).map((r) => r.name), []);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

// ---- 4. Lab page finishes without failures that are not network related
// -------------------------------
await single('lab page runs the loopback pairing', async () => {
  const page = await newPage();
  await page.goto(`${base}/lab/lab.html`);
  await page.waitForFunction(() => window.labDone, null, { timeout: 30000 });
  const rows = await page.locator('tbody tr').allTextContents();
  assert.ok(rows.some((r) => /Pairing.*ok/.test(r)), rows.join('\n'));
  // WebCrypto (ok) or the JS fallback (info) are both fine; only a missing fallback fails.
  assert.ok(rows.some((r) => /Ed25519\s*(ok|info)/.test(r)), rows.join('\n'));
  await page.context().close();
}, { live: true });

await browser.close();
server?.close();
if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1); }
console.log('\nall e2e checks passed');
