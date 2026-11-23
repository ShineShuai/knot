// When the page asks for a backup file: only with something to lose, only without a folder
// backup, after the chosen number of days, and not again at once after "Later".
import test from 'node:test';
import assert from 'node:assert/strict';
import { isBackupKey } from '../src/store/backup.js';
import { MemoryKV } from '../src/store/kv.js';
import {
  DAY, REMIND_CHOICES, SNOOZE_DAYS, backupDue, lastBackup, noteBackup, snooze,
} from '../src/store/reminder.js';

const T = Date.UTC(2026, 10, 23);
const ask = (kv, over = {}, at = T) => backupDue({
  kv, settings: { backupReminderDays: 14 }, hasHistory: true, folderOn: false, now: at, ...over,
});

test('nothing to lose, a folder backup, or "never": no reminder, nothing counted', async () => {
  const kv = new MemoryKV();
  assert.equal(await ask(kv, { hasHistory: false }, T + 99 * DAY), null);
  assert.equal(await ask(kv, { folderOn: true }, T + 99 * DAY), null);
  assert.equal(await ask(kv, { settings: { backupReminderDays: 0 } }, T + 99 * DAY), null);
  assert.equal(await kv.get('backup'), undefined, 'counting starts with something to lose');
});

test('counting starts at the first look; then the reminder is due after the interval', async () => {
  const kv = new MemoryKV();
  assert.equal(await ask(kv), null, 'an update does not ask at once');
  assert.equal(await ask(kv, {}, T + 13 * DAY), null);
  assert.deepEqual(await ask(kv, {}, T + 14 * DAY), { age: null }, 'no backup was ever saved');
  assert.equal(await ask(kv, { settings: { backupReminderDays: 30 } }, T + 14 * DAY), null);
  const weekly = { settings: { backupReminderDays: 7 } };
  assert.deepEqual(await ask(kv, weekly, T + 14 * DAY), { age: null });
});

test('a saved backup restarts the count and gives the age in days', async () => {
  const kv = new MemoryKV();
  await ask(kv);
  await noteBackup(kv, T + 20 * DAY);
  assert.equal(await lastBackup(kv), T + 20 * DAY);
  assert.equal(await ask(kv, {}, T + 33 * DAY), null);
  assert.deepEqual(await ask(kv, {}, T + 34 * DAY + 5), { age: 14 });
});

test('"Later" waits a few days, whatever the interval', async () => {
  const kv = new MemoryKV();
  await ask(kv);
  const due = T + 14 * DAY;
  assert.ok(await ask(kv, {}, due));
  await snooze(kv, due);
  assert.equal(await ask(kv, {}, due + (SNOOZE_DAYS - 1) * DAY), null);
  assert.ok(await ask(kv, {}, due + SNOOZE_DAYS * DAY));
  await noteBackup(kv, due + SNOOZE_DAYS * DAY);
  assert.equal(await ask(kv, {}, due + SNOOZE_DAYS * DAY + DAY), null, 'a backup clears "Later"');
});

test('the note is not part of a backup, and the choices are the ones the page offers', () => {
  assert.equal(isBackupKey('backup'), false);
  assert.deepEqual(REMIND_CHOICES, [7, 14, 30]);
});
