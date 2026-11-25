// Identity recovery through the real UI over a fake DOM: Settings > Devices, and the empty
// room list's way to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, find } from './fake-dom.js';
import { AppModel } from '../src/app.js';
import { DEFAULTS } from '../src/config.js';
import { MemoryKV } from '../src/store/kv.js';
import { setLanguage } from '../src/ui/i18n.js';
import { mountUi } from '../src/ui/view.js';
import { newIdentity } from './helpers.js';
import { makeChainCert, makeRecoveryCert } from '../src/crypto/delegation.js';
import { until } from './fakes.js';

const { root: rootA } = installFakeDom();
const models = [];
test.afterEach(() => {
  setLanguage('en');
  models.splice(0).forEach((m) => m.rooms.forEach((r) => r.stop()));
});
const PASS = 'long enough';

async function person(name = 'Ada') {
  const settings = { ...DEFAULTS, name, brokersEnabled: false, brokers: [] };
  const kv = new MemoryKV();
  const model = new AppModel({ kv, identity: await newIdentity(), settings, iceServers: () => [] });
  models.push(model);
  const root = new rootA.constructor('div');
  const calls = { reloads: 0 };
  const ui = mountUi(root, model, { backupIterations: 1000, reload: () => { calls.reloads++; } });
  return { kv, model, root, ui, calls };
}
const dialog = (p) => p.root.querySelector('dialog');
const button = (p, label) => find(dialog(p), 'button', label)[0];
const readOnly = (t) => t.getAttribute('readOnly') !== null;
const type = (el, value) => { el.value = value; };
const said = (p) => dialog(p).querySelector('.recovery-result').textContent;
const saidRestore = (p) => dialog(p).querySelector('.recovery-restore-result').textContent;

async function openDevices(p) {
  find(p.root, 'button', 'Settings')[0].click();
  button(p, 'Devices').click();
  await until(() => dialog(p).textContent.includes('Identity recovery'));
}

test('ui: make a recovery code: a long passphrase, typed twice, the code shown once', async () => {
  const p = await person();
  await openDevices(p);
  await until(() => /No recovery code yet/.test(dialog(p).textContent));
  const field = (cls) => dialog(p).querySelector(cls);
  const [pass, again] = [field('.recovery-pass'), field('.recovery-pass2')];
  type(pass, 'short');
  button(p, 'Make a recovery code').click();
  await until(() => /at least 8/.test(said(p)));
  type(pass, PASS);
  type(again, 'long enough!');
  button(p, 'Make a recovery code').click();
  await until(() => /differ/.test(said(p)));
  assert.equal(await p.model.recoveryInfo(), null);

  type(again, PASS);
  button(p, 'Make a recovery code').click();
  await until(() => /^Your recovery code\./.test(said(p)));
  const [code] = dialog(p).querySelectorAll('textarea').filter(readOnly);
  assert.match(code.value, /^knot-ik1-[A-Za-z0-9_-]+$/);
  assert.equal(pass.value, '', 'the passphrase is not kept on the page');
  await until(() => /A recovery code was made on/.test(dialog(p).textContent));
  assert.ok(button(p, 'Make a new code (the old one stops working)'));
  assert.equal((await p.model.recoveryInfo()).channel, false);
});

test('ui: cancelling the recovery code withdraws it', async () => {
  const p = await person();
  await p.model.makeRecoveryCode(PASS, { iterations: 1000 });
  await openDevices(p);
  await until(() => button(p, 'Cancel the recovery code'));
  button(p, 'Cancel the recovery code').click();
  await until(() => /was cancelled/.test(said(p)));
  assert.equal(await p.model.recoveryInfo(), null);
  await until(() => button(p, 'Make a recovery code'));
});

test('ui: a wiped device takes its identity back: bad code, wrong passphrase, ok', async () => {
  const main = await person('Ada');
  const code = await main.model.makeRecoveryCode(PASS, { iterations: 1000 });
  const wiped = await person('');
  await openDevices(wiped);
  const [box, pass] = ['.recovery-code', '.recovery-restore-pass'].map(
    (c) => dialog(wiped).querySelector(c),
  );
  const restore = () => button(wiped, 'Restore identity').click();
  type(box, 'just words');
  type(pass, PASS);
  restore();
  await until(() => /not a recovery code/.test(saidRestore(wiped)));
  type(box, code);
  type(pass, 'not the passphrase');
  restore();
  await until(() => /Wrong passphrase/.test(saidRestore(wiped)));
  assert.equal(await wiped.kv.get('delegate'), undefined);
  assert.equal(wiped.calls.reloads, 0);

  type(pass, PASS);
  restore();
  await until(() => wiped.calls.reloads === 1);
  assert.match(saidRestore(wiped), /Identity restored/);
  const { cert } = await wiped.kv.get('delegate');
  assert.equal(cert.up.q, (await main.model.recoveryInfo()).q);
  assert.equal(cert.r, cert.up.r);
});

test('ui: a device that owns rooms is told it cannot swap its identity', async () => {
  const main = await person('Ada');
  const code = await main.model.makeRecoveryCode(PASS, { iterations: 1000 });
  const owner = await person('Bob');
  await owner.model.createRoom('Mine');
  await openDevices(owner);
  type(dialog(owner).querySelector('.recovery-code'), code);
  type(dialog(owner).querySelector('.recovery-restore-pass'), PASS);
  button(owner, 'Restore identity').click();
  await until(() => /owns rooms or has linked devices/.test(saidRestore(owner)));
  assert.equal(owner.calls.reloads, 0);
});

test('ui: the empty room list offers it, and it lands on the Devices page', async () => {
  const p = await person();
  const open = find(p.root, 'button', 'Restore identity');
  assert.equal(open.length, 1);
  open[0].click();
  await until(() => dialog(p)?.textContent.includes('Restore your identity'));
  assert.ok(dialog(p).querySelector('.recovery-code'));
});

test('ui: a device that joined with the code: bar, mark in the list, "that was me"', async () => {
  const p = await person();
  await p.model.createRoom('Club');
  const { identity } = p.model;
  const { device, cert } = await (async () => {
    const q = await newIdentity();
    const d = await newIdentity();
    const rc = await makeRecoveryCert(identity, q.pub);
    return { device: d, cert: await makeChainCert(q, rc, d.pub, 'Mac') };
  })();
  const room = [...p.model.rooms.values()][0];
  const bar = () => p.root.querySelectorAll('.update-bar').find(
    (b) => /recovery code/.test(b.textContent),
  );
  assert.equal(bar(), undefined);
  room.emit('sibling', { cert, pub: device.pub, member: identity.member, sibling: true });
  await until(() => bar() && !bar().hidden);
  assert.match(bar().textContent, /A device joined with your recovery code: Mac/);

  find(bar(), 'button', 'Review devices')[0].click();
  await until(() => dialog(p)?.textContent.includes('Identity recovery'));
  assert.match(dialog(p).textContent, /restored with a recovery code/);
  find(dialog(p), 'button', 'Close')[0]?.click();

  find(bar(), 'button', 'That was me')[0].click();
  await until(() => bar().hidden);
  assert.equal(p.model.restoredNotices.length, 0);
});

test('ui: "Cancel the recovery code" in the bar works from any device', async () => {
  const p = await person();
  const room = await p.model.createRoom('Club');
  const q = await newIdentity();
  const d = await newIdentity();
  const rc = await makeRecoveryCert(p.model.identity, q.pub);
  const cert = await makeChainCert(q, rc, d.pub, 'Mac');
  room.emit('sibling', { cert, pub: d.pub, member: p.model.identity.member, sibling: true });
  const bar = () => p.root.querySelectorAll('.update-bar').find(
    (b) => /recovery code/.test(b.textContent),
  );
  await until(() => bar() && !bar().hidden);
  find(bar(), 'button', 'Cancel the recovery code')[0].click();
  await until(() => bar().hidden);
  assert.equal(room.isWithdrawn(cert, p.model.identity.member), true);
});
