// The settings pages over the fake DOM: what applies at once, what waits for Apply, what is
// refused, and the validation of the network lists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeElement, installFakeDom, find } from './fake-dom.js';
import { AppModel } from '../src/app.js';
import { DEFAULTS, networkDefaults, networkProblems } from '../src/config.js';
import { MemoryKV } from '../src/store/kv.js';
import { setLanguage } from '../src/ui/i18n.js';
import { mountUi } from '../src/ui/view.js';
import { newIdentity } from './helpers.js';
import { FakeLink } from './fakes.js';

const { root: rootA } = installFakeDom();
test.afterEach(() => setLanguage('en'));

async function person(overrides = {}) {
  const settings = { ...DEFAULTS, name: 'Ada', brokersEnabled: false, brokers: [], ...overrides };
  const model = new AppModel({
    kv: new MemoryKV(), identity: await newIdentity(), settings, iceServers: () => [],
    linkFactory: () => new FakeLink(),
  });
  const root = new rootA.constructor('div');
  mountUi(root, model);
  find(root, 'button', 'Settings')[0].click();
  const dialog = root.querySelector('dialog');
  const page = (name) => find(dialog, 'button', name)[0].click();
  const toast = () => root.querySelector('.toast')?.textContent;
  return { model, root, dialog, page, toast };
}

test('networkProblems: names the field, the problem and the entry', () => {
  const ok = networkDefaults();
  assert.deepEqual(networkProblems(ok), []);
  const problems = (patch) => networkProblems({ ...ok, ...patch });
  assert.deepEqual(problems({ stunServers: ['stun:a', 'x'] }), [
    { field: 'stun', code: 'badStun', n: 2 }]);
  assert.deepEqual(problems({ brokers: ['ws://a'] }), [
    { field: 'brokers', code: 'badBroker', n: 1 }]);
  assert.deepEqual(problems({ turnServers: [{ urls: 'http://a' }] }), [
    { field: 'turn', code: 'badTurn', n: 1 }]);
  assert.deepEqual(problems({ turnServers: [{ urls: 'turns:a:443', username: 'u' }] }), [
    { field: 'turn', code: 'turnLogin', n: 1 }]);
  assert.deepEqual(problems({ turnServers: [{ urls: ['turn:a', 'stun:b'], username: 'u',
    credential: 'p' }] }), [], 'a list of addresses, with a login');
  assert.deepEqual(problems({ turnServers: [{ urls: 'stun:a' }] }), [], 'stun needs no login');
  assert.equal(problems({ brokers: Array(11).fill('wss://a') })[0].code, 'listLimits');
  assert.equal(problems({ stunServers: [`stun:${'a'.repeat(200)}`] })[0].code, 'listLimits');
});

test('networkDefaults: fresh copies, not the shared lists', () => {
  const d = networkDefaults();
  d.brokers.push('wss://x');
  assert.equal(networkDefaults().brokers.length, DEFAULTS.brokers.length);
});

test('ui: Settings opens on General; a page is kept while another is visited', async () => {
  const { dialog, page } = await person();
  assert.ok(dialog.classList.contains('paged'));
  assert.ok(!dialog.classList.contains('shell'), "'shell' is the page's own grid layout");
  assert.deepEqual(
    dialog.querySelector('nav').querySelectorAll('button').map((b) => b.textContent),
    ['General', 'Network', 'Devices', 'Data', 'About'],
    'no Notifications page without browser support',
  );
  assert.equal(dialog.querySelectorAll('select').length, 2, 'language and previews');
  const name = dialog.querySelector('input');
  name.value = 'Typed';
  page('Network');
  assert.equal(dialog.querySelectorAll('select').length, 0, 'only the open page is shown');
  page('General');
  assert.equal(dialog.querySelector('input').value, 'Typed', 'what was typed is still there');
});

test('ui: name and previews apply at once and say who gets them', async () => {
  const { model, dialog, toast } = await person();
  assert.equal(dialog.querySelector('.chip').textContent, 'All your devices');
  const name = dialog.querySelector('input');
  name.value = '  Grace ';
  name.fire('change');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(model.settings.name, 'Grace');
  const previews = dialog.querySelectorAll('select')[1];
  previews.value = 'off';
  previews.fire('change');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(model.settings.imagePreviews, 'off');
  assert.match(toast(), /Saved/);
});

test('ui: Data and About are about this device, not shared', async () => {
  const { dialog, page } = await person();
  page('Data');
  assert.equal(dialog.querySelector('.chip').textContent, 'This device');
  assert.ok(dialog.querySelector('.chip').className.includes('me'));
  page('About');
  assert.equal(dialog.querySelector('.chip'), null);
});

test('ui: Network: a bad list is shown under its field and is not applied', async () => {
  const { model, dialog, page } = await person();
  page('Network');
  const [brokers, stun] = dialog.querySelectorAll('textarea');
  const apply = find(dialog, 'button', 'Apply')[0];
  stun.value = 'stun:ok.test:3478\nfoo';
  stun.fire('input');
  const errors = () => dialog.querySelectorAll('.err').filter((p) => !p.hidden)
    .map((p) => p.textContent);
  assert.deepEqual(errors(), ['Line 2: STUN addresses start with stun: or stuns:']);
  assert.equal(apply.disabled, true);
  apply.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.notEqual(model.settings.stunServers.join(), 'stun:ok.test:3478,foo');
  assert.ok(dialog.querySelector('details').open, 'the advanced part opens to show it');
  brokers.value = 'https://nope';
  brokers.fire('input');
  assert.equal(errors().length, 2);
  assert.match(errors()[0], /Line 1: brokers must use wss:\/\//);
});

test('ui: Network: Apply saves the lists together; TURN is kept as rows', async () => {
  const { model, dialog, page, toast } = await person({
    turnServers: [{ urls: 'turn:a.test:3478', username: 'u', credential: 'p', extra: 1 }],
  });
  page('Network');
  const [brokers, stun] = dialog.querySelectorAll('textarea');
  assert.deepEqual(find(dialog, 'input', '').map((i) => i.value).filter(Boolean)
    .slice(-3), ['turn:a.test:3478', 'u', 'p']);
  brokers.value = 'wss://one.test/mqtt\n\nwss://two.test/mqtt ';
  stun.value = 'stuns:s.test:5349';
  const rows = dialog.querySelector('.turn-rows');
  rows.querySelectorAll('input')[1].value = 'v';
  find(dialog, 'button', 'Add TURN server')[0].click();
  assert.equal(rows.querySelectorAll('.turn').length, 2, 'an empty row to fill');
  find(dialog, 'button', 'Apply')[0].click();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(model.settings.brokers, ['wss://one.test/mqtt', 'wss://two.test/mqtt']);
  assert.deepEqual(model.settings.stunServers, ['stuns:s.test:5349']);
  assert.deepEqual(model.settings.turnServers, [
    { urls: 'turn:a.test:3478', username: 'v', credential: 'p', extra: 1 }],
  'the empty row is dropped; other keys of a server stay');
  assert.match(toast(), /Saved/);
});

test('ui: Network: Reset to defaults fills the controls and waits for Apply', async () => {
  const { model, dialog, page } = await person({ stunServers: ['stun:mine.test:1'] });
  page('Network');
  find(dialog, 'button', 'Reset to defaults')[0].click();
  const [brokers, stun] = dialog.querySelectorAll('textarea');
  assert.equal(stun.value, DEFAULTS.stunServers.join('\n'));
  assert.equal(brokers.value, DEFAULTS.brokers.join('\n'));
  assert.equal(dialog.querySelector('.apply').hidden, false);
  assert.deepEqual(model.settings.stunServers, ['stun:mine.test:1'], 'not saved yet');
  find(dialog, 'button', 'Apply')[0].click();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(model.settings.stunServers, DEFAULTS.stunServers);
});

test('ui: Network: Revert draws the page again from what is saved', async () => {
  const { model, dialog, page } = await person();
  page('Network');
  dialog.querySelectorAll('textarea')[1].value = 'stun:other.test:1';
  find(dialog, 'button', 'Revert')[0].click();
  assert.equal(dialog.querySelectorAll('textarea')[1].value, model.settings.stunServers.join('\n'));
});

test('ui: the link for the network test is on the Network page, not beside Close', async () => {
  const { dialog, page } = await person();
  assert.equal(dialog.querySelector('.dialog-footer a'), null);
  page('Network');
  assert.equal(find(dialog, 'a', 'Run network test')[0].href, 'lab/lab.html');
});

/** Change the network page without applying it: its Apply bar shows. */
function edit(dialog, page) {
  page('Network');
  find(dialog, 'button', 'Reset to defaults')[0].click();
}

/** A confirm() that answers `state.answer` and keeps the questions asked. */
function asking(answer) {
  const ask = globalThis.confirm;
  const state = { answer, asked: [], restore: () => { globalThis.confirm = ask; } };
  globalThis.confirm = (text) => { state.asked.push(text); return state.answer; };
  return state;
}

const reopen = (root) => find(root, 'button', 'Settings')[0].click();
const settle = () => new Promise((r) => setTimeout(r, 15));

test('ui: closing asks only if something was not applied; ×, Close, Escape alike', async () => {
  const { root, dialog, page } = await person();
  const q = asking(false);
  try {
    find(dialog, 'button', 'Close')[0].click();
    assert.equal(dialog.open, false, 'nothing to lose: it closes');
    assert.equal(q.asked.length, 0, 'and nothing was asked');

    reopen(root);
    edit(dialog, page);
    find(dialog, 'button', 'Close')[0].click();
    assert.equal(dialog.open, true, 'declined: it stays open');
    assert.deepEqual(q.asked, ['Changes that were not applied will be lost. Continue?']);
    dialog.querySelector('header').querySelector('button').click(); // ×
    assert.equal(dialog.open, true);
    let kept = false;
    dialog.fire('cancel', { preventDefault() { kept = true; } }); // Escape
    assert.equal(kept, true, 'Escape is held back too');
    assert.equal(q.asked.length, 3);

    q.answer = true;
    find(dialog, 'button', 'Close')[0].click();
    assert.equal(dialog.open, false, 'confirmed: it closes, the edit is dropped');
    assert.equal(q.asked.length, 4);
  } finally { q.restore(); }
});

test('ui: applying or reverting leaves nothing to lose; other dialogs are not asked', async () => {
  const { root, dialog, page, model } = await person();
  const q = asking(false);
  try {
    edit(dialog, page);
    find(dialog, 'button', 'Apply')[0].click();
    await settle();
    assert.deepEqual(model.settings.stunServers, DEFAULTS.stunServers, 'applied');
    reopen(root);
    edit(dialog, page);
    find(dialog, 'button', 'Revert')[0].click(); // drawn again from what is saved
    let kept = false;
    dialog.fire('cancel', { preventDefault() { kept = true; } });
    assert.equal(kept, false, 'Escape is not held back');
    find(dialog, 'button', 'Close')[0].click();
    assert.equal(dialog.open, false);
    assert.equal(q.asked.length, 0);

    find(root, 'button', 'New room')[0].click(); // a dialog that never asks
    find(dialog, 'button', 'Cancel')[0].click();
    assert.equal(dialog.open, false);
    assert.equal(q.asked.length, 0);
  } finally { q.restore(); }
});

test('ui: a new language redraws the dialog: it asks before dropping unapplied edits', async () => {
  const { dialog, page, model } = await person();
  const q = asking(false);
  try {
    edit(dialog, page);
    page('General');
    const language = dialog.querySelectorAll('select')[0];
    language.value = 'de';
    language.fire('change');
    assert.equal(language.value, 'auto', 'declined: the choice is taken back');
    assert.equal(model.settings.language, 'auto');
    assert.equal(q.asked.length, 1);
    q.answer = true;
    language.value = 'de';
    language.fire('change');
    await settle();
    assert.equal(model.settings.language, 'de');
  } finally { q.restore(); }
});

const focusedText = () => FakeElement.focused?.textContent;

test('ui: the dialog is named by its title, and a screen reader starts at the pages', async () => {
  const { dialog } = await person();
  const title = dialog.querySelector('h2');
  assert.equal(dialog.getAttribute('aria-labelledby'), title.id);
  assert.equal(title.textContent, 'Settings');
  assert.equal(focusedText(), 'General', 'the first page, not the ×');
  assert.equal(dialog.querySelector('nav').getAttribute('aria-label'), 'Settings');
  const page = dialog.querySelector('.spage');
  assert.equal(page.getAttribute('aria-labelledby'), 'spage-title');
  assert.equal(page.querySelector('h3').id, 'spage-title');
});

test('ui: with the list beside the page, choosing a page does not move the focus', async () => {
  const { dialog, page } = await person();
  FakeElement.focused = find(dialog, 'button', 'General')[0];
  page('Network');
  assert.equal(focusedText(), 'General', 'the focus is not taken to the page');
  assert.equal(find(dialog, 'button', 'Network')[0].getAttribute('aria-current'), 'true');
  assert.equal(find(dialog, 'button', 'General')[0].getAttribute('aria-current'), 'false');
});

test('ui: on a narrow screen the focus follows: page heading, and back to the list', async () => {
  const { dialog, page } = await person();
  const real = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ display: 'none' }); // the list is not on screen
  try {
    page('Network');
    assert.equal(FakeElement.focused.tagName?.toLowerCase(), 'h3');
    assert.equal(focusedText(), 'Network', 'the heading of the page');
    const back = dialog.querySelector('.sback');
    assert.equal(back.getAttribute('aria-label'), 'Back to Settings');
    back.click();
    assert.equal(FakeElement.focused.textContent, 'Network', 'the list item we came from');
    assert.equal(FakeElement.focused.tagName?.toLowerCase(), 'button');
  } finally { globalThis.getComputedStyle = real; }
});

test('ui: a page drawn again keeps the focus in the page only if it was there', async () => {
  const { dialog, page } = await person();
  page('Network');
  const revert = find(dialog, 'button', 'Revert')[0];
  const inPage = (el) => !!el?.parentNode;
  FakeElement.focused = find(dialog, 'button', 'General')[0];
  revert.click();
  assert.equal(focusedText(), 'General', 'not moved when it was elsewhere');
  assert.ok(inPage(dialog.querySelector('h3')));
});
