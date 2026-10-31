// Linked devices through the real UI over a fake DOM: both devices' dialogs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, find } from './fake-dom.js';
import { AppModel } from '../src/app.js';
import { DEFAULTS } from '../src/config.js';
import { MemoryKV } from '../src/store/kv.js';
import { newRoomSecret } from '../src/crypto/room-keys.js';
import { mountUi } from '../src/ui/view.js';
import { newIdentity } from './helpers.js';
import { until } from './fakes.js';

const { root: rootA } = installFakeDom();
const models = [];
test.afterEach(() => models.splice(0).forEach((m) => m.rooms.forEach((r) => r.stop())));

async function person(name) {
  const settings = { ...DEFAULTS, name, brokersEnabled: false, brokers: [] };
  const kv = new MemoryKV();
  const model = new AppModel({ kv, identity: await newIdentity(), settings, iceServers: () => [] });
  models.push(model);
  const root = new rootA.constructor('div');
  return { kv, model, root, ui: mountUi(root, model) };
}

const dialog = (p) => p.root.querySelector('dialog');
const button = (p, label) => find(dialog(p), 'button', label)[0];
// the fake DOM keeps `readOnly` as an attribute
const readOnly = (t) => t.getAttribute('readOnly') !== null;
const editable = (p) => dialog(p).querySelectorAll('textarea').filter((t) => !readOnly(t));
const shown = (p) => dialog(p).querySelectorAll('textarea').filter(readOnly);

async function openDevices(p) {
  find(p.root, 'button', 'Settings')[0].click();
  button(p, 'Linked devices').click();
  await until(() => dialog(p).textContent.includes('Link another device')
    || dialog(p).textContent.includes('is linked to'));
}

test('ui: link a phone with two codes, check the digits, then unlink it', async () => {
  const [main, phone] = [await person('Ada'), await person('')];
  await main.model.addRoom(newRoomSecret(), 'Club');
  await openDevices(main);
  await openDevices(phone);
  assert.match(dialog(main).textContent, /No linked devices yet/);

  button(phone, 'Create code').click(); // the phone shows its code
  await until(() => shown(phone).length === 1);
  const request = shown(phone)[0].value;
  assert.match(request, /^knotdev1-/);

  editable(main)[0].value = request; // the main device takes it
  button(main, 'Create link code').click();
  await until(() => shown(main).length === 1);
  const grant = shown(main)[0].value;
  const digits = dialog(main).querySelector('.sas').textContent;
  assert.match(digits, /^\d{3} \d{3}$/);
  assert.equal(dialog(main).querySelectorAll('.device-alias').length, 2, 'listed at once');
  assert.equal(editable(main)[0].value, '', 'the box is free for the next code');

  editable(phone).at(-1).value = grant; // and hands the answer back (its last box)
  button(phone, 'Connect').click();
  await until(() => find(dialog(phone), 'button', 'Link').length);
  assert.equal(dialog(phone).querySelector('.sas').textContent, digits);
  assert.match(dialog(phone).textContent, /get 1 rooms/);

  let reloaded = 0;
  location.reload = () => { reloaded++; };
  button(phone, 'Link').click();
  await until(() => reloaded === 1);
  assert.ok(await phone.kv.get('delegate'));
  assert.equal(phone.model.settings.name, 'Ada');

  await openDevices(main); // the main device lists it, and can unlink it
  const aliases = dialog(main).querySelectorAll('.device-alias').map((i) => i.value);
  assert.match(aliases.join(), /device-/, 'the phone has an alias of its own');
  button(main, 'Unlink').click();
  await until(() => dialog(main).textContent.includes('No linked devices yet'));
  assert.deepEqual(await main.model.linkedDevices(), []);
});

test('ui: a bad code from the other device is refused', async () => {
  const [main, phone] = [await person('Ada'), await person('')];
  await openDevices(main);
  editable(main)[0].value = 'knotdev1-nonsense';
  button(main, 'Create link code').click();
  await until(() => /not a valid device code/.test(main.root.querySelector('.toast').textContent));
  await openDevices(phone);
  button(phone, 'Create code').click();
  await until(() => shown(phone).length === 1);
  editable(phone).at(-1).value = 'knotdev2-nonsense';
  button(phone, 'Connect').click();
  await until(() => /not a valid code/.test(phone.root.querySelector('.toast').textContent));
  assert.equal(find(dialog(phone), 'button', 'Link').length, 0);
});

async function linkViaUi(main, phone) {
  await openDevices(main);
  await openDevices(phone);
  button(phone, 'Create code').click();
  await until(() => shown(phone).length === 1);
  editable(main)[0].value = shown(phone)[0].value;
  button(main, 'Create link code').click();
  await until(() => shown(main).length === 1);
  editable(phone).at(-1).value = shown(main)[0].value;
  button(phone, 'Connect').click();
  await until(() => find(dialog(phone), 'button', 'Link').length);
  button(phone, 'Link').click();
  await until(() => phone.kv.get('delegate'));
}

test('ui: aliases change with Save, not with Cancel; Settings can be cancelled', async () => {
  const [main, phone] = [await person('Ada'), await person('')];
  location.reload = () => {};
  await linkViaUi(main, phone);
  const field = () => dialog(main).querySelectorAll('.device-alias')
    .find((i) => i.value.startsWith('device-'));
  await openDevices(main);
  field().value = 'tablet';
  button(main, 'Cancel').click();
  assert.ok(main.model.deviceRows().every((r) => r.alias !== 'tablet'), 'Cancel drops it');
  await openDevices(main);
  assert.ok(field(), 'the field shows what is saved');
  field().value = 'tablet';
  button(main, 'Save').click();
  await until(() => main.model.deviceRows().some((r) => r.alias === 'tablet'));
  await until(() => /saved/i.test(main.root.querySelector('.toast').textContent));
  find(main.root, 'button', 'Settings')[0].click();
  assert.ok(button(main, 'Cancel'), 'Settings has Save and Cancel');
  assert.ok(button(main, 'Save'));
});
