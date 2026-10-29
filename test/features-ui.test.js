// Unread counts, notifications, reactions, edit, search, export, update bar and the
// notification setting, driven through the real UI over a fake DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, find } from './fake-dom.js';
import { AppModel } from '../src/app.js';
import { DEFAULTS } from '../src/config.js';
import { newRoomSecret } from '../src/crypto/room-keys.js';
import { MemoryKV } from '../src/store/kv.js';
import { dictionaries, setLanguage } from '../src/ui/i18n.js';
import { MORE, QUICK } from '../src/ui/emoji.js';
import { mountUi } from '../src/ui/view.js';
import { Emitter } from '../src/util/emitter.js';
import { newIdentity } from './helpers.js';
import { FakeLink, until } from './fakes.js';
import { callParty } from './call-fakes.js';
import { link, makeRoom, stopRooms } from './room-kit.js';

const { root: rootA, document } = installFakeDom();
rootA.constructor.prototype.scrollIntoView = () => {}; // the fake DOM has no layout
const rooms = [];
test.afterEach(() => {
  rooms.splice(0).forEach((r) => r.stop());
  stopRooms();
  setLanguage('en');
  document.title = '';
});

async function person(name, { notifierEnv, updates, notifications = false, callEnv } = {}) {
  const settings = {
    ...DEFAULTS, name, brokersEnabled: false, brokers: [], gatherTimeoutMs: 10, notifications,
  };
  const model = new AppModel({
    kv: new MemoryKV(), identity: await newIdentity(), settings, iceServers: () => [],
    linkFactory: () => new FakeLink(), callEnv,
  });
  const root = new rootA.constructor('div');
  return { model, root, ui: mountUi(root, model, { notifierEnv, updates }) };
}

/** Two people in one room, both with a screen, both looking at it. */
async function chatting() {
  const secret = newRoomSecret();
  const [a, b] = [await person('Ada'), await person('Bob')];
  const [ra, rb] = [await a.model.addRoom(secret, 'Club'), await b.model.addRoom(secret, 'Club')];
  rooms.push(ra, rb);
  await link(ra, rb);
  a.ui.select(ra);
  b.ui.select(rb);
  return { a, b, ra, rb };
}

const messages = (p) => p.root.querySelectorAll('.msg');
const message = (p, text) => messages(p).find((el) => el.textContent.includes(text));
const button = (el, label) => find(el, 'button', label)[0];
const labelled = (el, label) => el.querySelector(`[aria-label="${label}"]`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function notifierEnv({ permission = 'granted', supported = true } = {}) {
  const env = {
    permission, asked: 0, shown: [],
    supported: () => supported,
    permission: () => env.state,
    request: async () => { env.asked++; env.state = env.grant ? 'granted' : 'denied'; },
    show: async (title, options, onclick) => { env.shown.push({ title, options, onclick }); },
    state: permission, grant: true,
  };
  return env;
}

test('ui: unread count in list and tab title, notification; reading clears them', async () => {
  const env = notifierEnv();
  const a = await person('Ada', { notifierEnv: env, notifications: true });
  const secret = newRoomSecret();
  const ra = await a.model.addRoom(secret, 'Club');
  rooms.push(ra);
  const bob = await makeRoom({ secret, name: 'Bob' });
  await link(ra, bob);

  await bob.sendText('hello\nthere');
  await until(() => a.root.querySelector('.unread')?.textContent === '1');
  assert.equal(document.title, '(1) knot');
  assert.ok(a.root.querySelector('.room-name').classList.contains('new'));
  await until(() => env.shown.length === 1);
  assert.equal(env.shown[0].options.body, 'Bob: hello there');

  env.shown[0].onclick(); // the user taps the notification
  assert.equal(a.root.querySelector('h2').textContent, 'Club');
  await until(() => !a.root.querySelector('.unread'));
  assert.equal(document.title, 'knot');

  await bob.sendText('second'); // now they are looking at it
  await until(() => message(a, 'second'));
  await wait(450);
  assert.equal(env.shown.length, 1);
  assert.equal(a.root.querySelector('.unread'), null);
});

test('ui: react with an emoji, see it on both screens, take it back', async () => {
  const { a, b, ra } = await chatting();
  await ra.sendText('lunch?');
  await until(() => message(b, 'lunch?'));
  assert.equal(message(b, 'lunch?').querySelector('.palette'), null);
  button(message(b, 'lunch?'), 'React').click();
  const picks = message(b, 'lunch?').querySelectorAll('.pick');
  assert.equal(picks.length, 6);
  picks[0].click();
  await until(() => message(a, 'lunch?').querySelector('.rx')?.textContent === '👍 1');
  const mine = message(b, 'lunch?').querySelector('.rx');
  assert.equal(mine.textContent, '👍 1');
  assert.ok(mine.classList.contains('mine'));
  assert.ok(!message(a, 'lunch?').querySelector('.rx').classList.contains('mine'));
  assert.equal(message(b, 'lunch?').querySelector('.palette'), null, 'the palette closes');
  mine.click();
  await until(() => !message(a, 'lunch?').querySelector('.rx'));
  assert.equal(message(b, 'lunch?').querySelector('.rx'), null);
});

test('ui: edit your own message through the message box; Escape backs out', async () => {
  const { a, b } = await chatting();
  const box = a.root.querySelector('textarea');
  box.value = 'helo world';
  box.fire('keydown', { key: 'Enter' });
  await until(() => message(b, 'helo world'));
  assert.equal(find(message(b, 'helo world'), 'button', 'Edit').length, 0, 'only the author');

  button(message(a, 'helo world'), 'Edit').click();
  assert.equal(box.value, 'helo world');
  assert.match(a.root.querySelector('.quote-bar').textContent, /^Editing/);
  box.fire('keydown', { key: 'Escape' });
  assert.equal(box.value, '');
  assert.equal(a.root.querySelector('.quote-bar').hidden, true);

  button(message(a, 'helo world'), 'Edit').click();
  box.value = 'hello world';
  box.fire('keydown', { key: 'Enter' });
  await until(() => message(b, 'hello world'));
  const text = message(b, 'hello world').querySelector('.text');
  assert.equal(text.textContent, 'hello world (edited)');
  const own = messages(a).filter((el) => el.classList.contains('own'));
  assert.equal(own.length, 1, 'an edit is not a new message');
  assert.equal(a.root.querySelector('.quote-bar').hidden, true);
  assert.equal(box.value, '');
});

test('ui: search shows only hits, then jumps back into the conversation', async () => {
  const { a, ra } = await chatting();
  for (const text of ['alpha one', 'beta two', 'alpha three']) await ra.sendText(text);
  await until(() => messages(a).length === 3);
  const open = a.root.querySelectorAll('[aria-label="Search messages"]')
    .find((el) => el.tagName === 'BUTTON');
  open.click();
  const bar = a.root.querySelector('.searchbar');
  assert.equal(bar.hidden, false);
  const input = bar.querySelector('input');
  input.value = 'ALPHA';
  input.fire('input');
  assert.equal(messages(a).length, 2);
  assert.equal(bar.querySelector('.search-count').textContent, '2 found');
  assert.equal(find(messages(a)[0], 'button', 'Edit').length, 0, 'hits only offer "show"');
  input.value = 'zebra';
  input.fire('input');
  assert.equal(messages(a).length, 0);
  assert.equal(bar.querySelector('.search-count').textContent, 'No messages found');
  input.value = 'beta';
  input.fire('input');
  button(messages(a)[0], 'Show in chat').click();
  assert.equal(bar.hidden, true);
  assert.equal(messages(a).length, 3);
  open.click();
  input.fire('keydown', { key: 'Escape' });
  assert.equal(bar.hidden, true);
});

test('ui: export saves the history as text or JSON', async () => {
  const { a, ra } = await chatting();
  await ra.sendText('alpha one');
  await until(() => messages(a).length === 1);
  const saved = [];
  const anchors = [];
  const makeElement = document.createElement;
  const makeUrl = URL.createObjectURL;
  document.createElement = (tag) => {
    const el = makeElement(tag);
    if (tag === 'a') anchors.push(el);
    return el;
  };
  URL.createObjectURL = (blob) => { saved.push(blob); return 'blob:test'; };
  try {
    a.root.querySelector('[aria-label="Export history"]').click();
    const dialog = a.root.querySelector('dialog');
    assert.match(dialog.textContent, /Saves the 1 messages/);
    button(dialog, 'Text').click();
    button(dialog, 'JSON').click();
  } finally {
    document.createElement = makeElement;
    URL.createObjectURL = makeUrl;
  }
  assert.match(anchors[0].download, /^knot-Club-\d{4}-\d\d-\d\d\.txt$/);
  assert.match(anchors[1].download, /\.json$/);
  assert.match(await saved[0].text(), /Ada: alpha one/);
  assert.equal(JSON.parse(await saved[1].text()).messages.length, 1);
});

test('ui: a new version shows a bar that reloads, and asks first during a call', async () => {
  const updates = new Emitter();
  const a = await person('Ada', { updates, callEnv: callParty().env });
  const bar = a.root.querySelector('.update-bar');
  assert.equal(bar.hidden, true);
  updates.emit('update');
  assert.equal(bar.hidden, false);
  assert.match(bar.textContent, /new version/);
  let reloads = 0;
  location.reload = () => { reloads++; };
  const room = await a.model.addRoom(newRoomSecret(), 'Club');
  rooms.push(room);
  await room.call.join();
  const ask = globalThis.confirm;
  globalThis.confirm = () => false;
  button(bar, 'Reload').click();
  assert.equal(reloads, 0, 'declined: the call goes on');
  globalThis.confirm = () => true;
  button(bar, 'Reload').click();
  assert.equal(reloads, 1);
  globalThis.confirm = ask;
  setLanguage('de');
  a.ui.relocalize();
  assert.match(bar.textContent, /neue Version/);
  bar.querySelector('[aria-label="Schließen"]').click();
  assert.equal(bar.hidden, true);
});

test('ui: switching notifications on asks the browser; a refusal keeps them off', async () => {
  const env = notifierEnv({ permission: 'default' });
  const a = await person('Ada', { notifierEnv: env });
  const save = async (expectToast) => {
    button(a.root, 'Settings').click();
    const dialog = a.root.querySelector('dialog');
    find(dialog, 'label', 'Notify me about new messages')[0].querySelector('input').checked = true;
    button(dialog, 'Save').click();
    await until(() => a.root.querySelector('.toast').textContent === expectToast);
  };
  env.grant = false;
  await save('Notifications are blocked in the browser settings');
  assert.equal(a.model.settings.notifications, false);
  assert.equal(env.asked, 1);
  env.state = 'default';
  env.grant = true;
  await save(dictionaries.en.saved);
  assert.equal(a.model.settings.notifications, true);
  assert.equal(env.asked, 2);
});

test('ui: without browser notifications the setting is not offered', async () => {
  const a = await person('Ada', { notifierEnv: notifierEnv({ supported: false }) });
  button(a.root, 'Settings').click();
  assert.equal(find(a.root.querySelector('dialog'), 'label', 'Notify me').length, 0);
});

test('ui: a web link in a message is a link, on both screens; other text is not', async () => {
  const { a, b, ra } = await chatting();
  await ra.sendText('docs: https://example.com/a?b=1, and javascript:alert(1) is just text');
  await until(() => message(b, 'docs:'));
  for (const p of [a, b]) {
    const anchors = message(p, 'docs:').querySelectorAll('a');
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0].href, 'https://example.com/a?b=1');
    assert.equal(anchors[0].textContent, 'https://example.com/a?b=1');
    assert.equal(anchors[0].getAttribute('target'), '_blank');
    assert.match(anchors[0].getAttribute('rel'), /noopener/);
    assert.match(message(p, 'docs:').querySelector('.text').textContent,
      /^docs: https:\/\/example.com\/a\?b=1, and javascript:alert\(1\) is just text$/);
  }
});

test('ui: more reactions: "+" opens every emoji, and any emoji can be typed', async () => {
  const { a, b, ra } = await chatting();
  await ra.sendText('party?');
  await until(() => message(b, 'party?'));
  button(message(b, 'party?'), 'React').click();
  const open = () => message(b, 'party?');
  assert.equal(open().querySelector('.palette-grid'), null, 'quick row first');
  labelled(open(), 'More emoji').click();
  const grid = open().querySelector('.palette-grid');
  assert.equal(grid.querySelectorAll('.pick').length, MORE.length);
  assert.equal(open().querySelectorAll('.pick').length, QUICK.length + MORE.length);
  labelled(open(), 'Fewer emoji').click(); // back to the quick row
  assert.equal(open().querySelector('.palette-grid'), null);
  assert.equal(open().querySelectorAll('.pick').length, 6);

  labelled(open(), 'More emoji').click();
  open().querySelectorAll('.pick').find((el) => el.textContent === '🎉').click();
  await until(() => message(a, 'party?').querySelector('.rx')?.textContent === '🎉 1');
  assert.equal(open().querySelector('.palette'), null, 'the palette closes, "more" is forgotten');

  button(open(), 'React').click();
  labelled(open(), 'More emoji').click();
  const any = open().querySelector('.rx-any');
  any.value = 'not an emoji';
  any.fire('input');
  any.value = '🦄';
  any.fire('input');
  await until(() => message(a, 'party?').querySelectorAll('.rx').length === 2);
  const chips = message(a, 'party?').querySelectorAll('.rx').map((el) => el.textContent);
  assert.deepEqual(chips.sort(), ['🎉 1', '🦄 1']);
});
