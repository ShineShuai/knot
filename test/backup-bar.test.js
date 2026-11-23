// The reminder bar and the reminder choices on Settings > Data, over the fake DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, find } from './fake-dom.js';
import { AppModel } from '../src/app.js';
import { DEFAULTS } from '../src/config.js';
import { MemoryKV } from '../src/store/kv.js';
import { DAY, lastBackup } from '../src/store/reminder.js';
import { setLanguage } from '../src/ui/i18n.js';
import { mountUi } from '../src/ui/view.js';
import { newIdentity } from './helpers.js';
import { FakeLink, until } from './fakes.js';

const { root: rootA } = installFakeDom();
test.afterEach(() => setLanguage('en'));
const T = Date.UTC(2026, 10, 23);

/** A person with a room and a message, and a clock that the test moves. */
async function person({ talk = true, ...opts } = {}) {
  const clock = { at: T };
  const settings = { ...DEFAULTS, name: 'Ada', brokersEnabled: false, brokers: [] };
  const model = new AppModel({
    kv: new MemoryKV(), identity: await newIdentity(), settings, iceServers: () => [],
    linkFactory: () => new FakeLink(),
  });
  if (talk) await (await model.createRoom('Club')).sendText('hello');
  const root = new rootA.constructor('div');
  const saved = [];
  const ui = mountUi(root, model, {
    now: () => clock.at, backupIterations: 1000, saveFile: (name) => saved.push(name), ...opts,
  });
  await ui.backupBar.check();
  const bar = () => root.querySelectorAll('.update-bar').find(
    (el) => /backup/i.test(el.textContent),
  );
  return { model, root, ui, clock, saved, bar };
}
const visibleBar = (p) => { const b = p.bar(); return b && !b.hidden ? b : null; };

test('ui: no bar at first; after the interval it asks ("never saved" or the days)', async () => {
  const p = await person();
  assert.equal(visibleBar(p), null, 'counting only started');
  p.clock.at = T + 14 * DAY;
  await p.ui.backupBar.check();
  assert.match(visibleBar(p).textContent, /not saved a backup yet/);
  assert.equal(find(visibleBar(p), 'button', 'Save a backup').length, 1);
});

test('ui: no bar without anything to lose', async () => {
  const p = await person({ talk: false });
  p.clock.at = T + 60 * DAY;
  await p.ui.backupBar.check();
  assert.equal(visibleBar(p), null);
});

test('ui: Later hides it for a few days; Save a backup opens the Data page', async () => {
  const p = await person();
  p.clock.at = T + 15 * DAY;
  await p.ui.backupBar.check();
  find(visibleBar(p), 'button', 'Later')[0].click();
  await until(() => !visibleBar(p));
  p.clock.at += 2 * DAY;
  await p.ui.backupBar.check();
  assert.equal(visibleBar(p), null);
  p.clock.at += 2 * DAY;
  await p.ui.backupBar.check();
  assert.ok(visibleBar(p));
  find(visibleBar(p), 'button', 'Save a backup')[0].click();
  const dialog = p.root.querySelector('dialog');
  assert.ok(dialog.open);
  assert.ok(dialog.querySelector('.backup-pass'));
});

test('ui: saving a backup file clears the bar and shows when it was saved', async () => {
  const p = await person();
  p.clock.at = T + 15 * DAY;
  await p.ui.backupBar.check();
  assert.ok(visibleBar(p));
  find(p.root, 'button', 'Settings')[0].click();
  const dialog = p.root.querySelector('dialog');
  find(dialog, 'button', 'Data')[0].click();
  const last = () => dialog.querySelector('.backup-last').textContent;
  await until(() => last() === 'No backup file saved yet.');
  for (const cls of ['.backup-pass', '.backup-pass2']) {
    dialog.querySelector(cls).value = 'long enough';
  }
  find(dialog, 'button', 'Save backup')[0].click();
  await until(() => p.saved.length === 1);
  await until(() => /^Last backup file saved: /.test(last()));
  assert.equal(await lastBackup(p.model.kv), T + 15 * DAY);
  await until(() => !visibleBar(p));
});

test('ui: the interval is chosen on the Data page; "never" ends the asking', async () => {
  const p = await person();
  p.clock.at = T + 15 * DAY;
  await p.ui.backupBar.check();
  assert.ok(visibleBar(p));
  find(p.root, 'button', 'Settings')[0].click();
  const dialog = p.root.querySelector('dialog');
  find(dialog, 'button', 'Data')[0].click();
  const select = dialog.querySelectorAll('select').find(
    (s) => s.children.some((o) => /every 7 days/.test(o.textContent)),
  );
  assert.deepEqual(select.children.map((o) => o.textContent),
    ['every 7 days', 'every 14 days', 'every 30 days', 'never']);
  assert.equal(select.value, '14');
  select.value = '30';
  select.fire('change');
  await until(() => p.model.settings.backupReminderDays === 30);
  await until(() => !visibleBar(p), 1000);
  p.clock.at = T + 46 * DAY;
  select.value = '0';
  select.fire('change');
  await until(() => p.model.settings.backupReminderDays === 0);
  await p.ui.backupBar.check();
  assert.equal(visibleBar(p), null);
});

test('ui: a running folder backup needs no reminder', async () => {
  const p = await person({ folder: { active: true, state: 'ok', on() {} } });
  p.clock.at = T + 60 * DAY;
  await p.ui.backupBar.check();
  assert.equal(visibleBar(p), null);
});
