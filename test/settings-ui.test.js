// The version in the room list and the language choice in Settings, over the fake DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, find } from './fake-dom.js';
import { AppModel } from '../src/app.js';
import { DEFAULTS } from '../src/config.js';
import { MemoryKV } from '../src/store/kv.js';
import { newRoomSecret } from '../src/crypto/room-keys.js';
import { dictionaries, setLanguage } from '../src/ui/i18n.js';
import { mountUi } from '../src/ui/view.js';
import { VERSION } from '../src/version.js';
import { newIdentity } from './helpers.js';
import { FakeLink, until } from './fakes.js';
import { callParty } from './call-fakes.js';

const { root: rootA } = installFakeDom();
const rooms = [];
test.afterEach(() => {
  rooms.splice(0).forEach((r) => r.stop());
  setLanguage('en');
});

async function person() {
  const settings = { ...DEFAULTS, name: 'Ada', brokersEnabled: false, brokers: [] };
  const kv = new MemoryKV();
  const model = new AppModel({
    kv, identity: await newIdentity(), settings, iceServers: () => [],
    linkFactory: () => new FakeLink(), callEnv: callParty().env,
  });
  const root = new rootA.constructor('div');
  return { kv, model, root, ui: mountUi(root, model) };
}

test('ui: the version is shown in the room list', async () => {
  const { root } = await person();
  assert.equal(root.querySelector('.version').textContent, `v${VERSION}`);
});

test('ui: choosing a language in Settings redraws the screen and is kept', async () => {
  const { kv, model, root, ui } = await person();
  const room = await model.addRoom(newRoomSecret(), 'Club');
  rooms.push(room);
  ui.select(room);
  root.querySelector('[aria-label="Start an audio call"]').click();
  await until(() => room.call.joined);
  assert.ok(find(root, 'button', 'Leave call').length);

  find(root, 'button', 'Settings')[0].click();
  const dialog = root.querySelector('dialog');
  const language = dialog.querySelectorAll('select')[0]; // the first field
  assert.deepEqual(
    language.querySelectorAll('option').map((o) => o.textContent),
    ['Automatic (browser)', 'English', '中文', 'Deutsch'],
  );
  language.value = 'de';
  find(dialog, 'button', 'Save')[0].click();
  await until(() => kv.get('settings').then((s) => s?.language === 'de'));

  assert.equal(model.settings.language, 'de');
  assert.ok(find(root, 'button', dictionaries.de.settings).length, 'room list');
  assert.ok(find(root, 'button', dictionaries.de.invite).length, 'room header');
  assert.ok(find(root, 'button', dictionaries.de.callLeave).length, 'call window');
  assert.equal(root.querySelector('.version').textContent, `v${VERSION}`);
  assert.equal(root.querySelector('.toast').textContent, dictionaries.de.saved);

  find(root, 'button', dictionaries.de.settings)[0].click(); // and back to the browser's
  const again = root.querySelector('dialog').querySelectorAll('select')[0];
  assert.equal(again.querySelectorAll('option')[0].textContent, dictionaries.de.languageAuto);
  again.value = 'auto';
  find(root.querySelector('dialog'), 'button', dictionaries.de.saveSettings)[0].click();
  await until(() => find(root, 'button', 'Settings').length > 0);
  assert.equal(model.settings.language, 'auto');
});

test('ui: a dialog never prints "null" for a field the browser cannot offer', async () => {
  const { root } = await person(); // no Notification support here: that field is left out
  find(root, 'button', 'Settings')[0].click();
  assert.ok(!root.querySelector('dialog').textContent.includes('null'));
});
