// End-to-end tests in real Chromium (real WebRTC, real IndexedDB, real UI).
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright node test/e2e/run.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { startServer } from '../../tools/serve.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const server = await startServer(0);
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  args: [
    '--no-sandbox',
    '--allow-loopback-in-peer-connection',
    '--disable-features=WebRtcHideLocalIpsWithMdns',
  ],
});
const failures = [];
async function check(name, fn) {
  if (process.env.E2E_ONLY && !name.includes(process.env.E2E_ONLY)) return;
  try { await fn(); console.log(`ok   ${name}`); } catch (err) {
    failures.push(name);
    console.log(`FAIL ${name}\n     ${err.stack ?? err}`);
  }
}
const newPage = async () => {
  const context = await browser.newContext(
    { serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] },
  );
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  // Public brokers are unreachable in offline test runs; that console noise is expected.
  page.on(
    'console',
    (m) => m.type() === 'error' && !/WebSocket connection to/.test(m.text()) && page.errors.push(
      m.text(),
    ),
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
await check('UI: create room, send message, persists after reload', async () => {
  const page = await newPage();
  await page.goto(`${base}/index.html`);
  await page.getByRole('button', { name: 'New room' }).click();
  await page.locator('dialog').waitFor();
  assert.match(
    await page.locator('dialog .copy-field textarea').first().inputValue(),
    /#r=[A-Za-z0-9_-]{22}$/,
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
});

// ---- 3. UI manual pairing between two browsers
// ------------------------------------------------------
await check('UI: pair two browsers with codes, chat both ways, share a file', async () => {
  const [a, b] = [await newPage(), await newPage()];
  await Promise.all([a, b].map((p) => p.goto(`${base}/index.html`)));
  await a.getByRole('button', { name: 'New room' }).click();
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
  for (const p of [a, b]) await p.locator('.peer.p2p').waitFor({ timeout: 15000 });
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
  await b.locator('.file', { hasText: 'note.txt' }).waitFor();
  await b.locator('.file button').click();
  const [download] = await Promise.all(
    [b.waitForEvent('download'), b.locator('.file a', { hasText: 'Save' }).click()],
  );
  assert.equal(download.suggestedFilename(), 'note.txt');
  assert.deepEqual([...a.errors, ...b.errors], []);
  await Promise.all([a, b].map((p) => p.context().close()));
});

// ---- 4. Lab page finishes without failures that are not network related
// -------------------------------
await check('lab page runs the loopback pairing', async () => {
  const page = await newPage();
  await page.goto(`${base}/lab/lab.html`);
  await page.waitForFunction(() => window.labDone, null, { timeout: 30000 });
  const rows = await page.locator('tbody tr').allTextContents();
  assert.ok(rows.some((r) => /Pairing.*ok/.test(r)), rows.join('\n'));
  assert.ok(rows.some((r) => /Ed25519.*ok/.test(r)));
  await page.context().close();
});

await browser.close();
server.close();
if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1); }
console.log('\nall e2e checks passed');
