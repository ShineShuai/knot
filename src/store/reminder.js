// When to remind the person to save a backup file. A browser without a folder backup (Firefox,
// Safari, or Chrome before the folder is set up) cannot save by itself, and cannot know when
// it will lose its data, so the page asks now and then. The note lives in the store under
// `backup` (not part of a backup): { at: when a file was last saved, since: when we began to
// count, later: no asking before this time }.
export const DAY = 86_400_000;
export const REMIND_CHOICES = [7, 14, 30]; // days; 0 in the settings is "never"
export const SNOOZE_DAYS = 3; // what "Later" means

const read = async (kv) => (await kv.get('backup')) ?? {};

/** A backup file was saved just now. */
export async function noteBackup(kv, now = Date.now()) {
  await kv.put('backup', { ...(await read(kv)), at: now, later: 0 });
}

/** "Later": ask again in a few days. */
export async function snooze(kv, now = Date.now()) {
  await kv.put('backup', { ...(await read(kv)), later: now + SNOOZE_DAYS * DAY });
}

/** When a backup file was last saved on this device (0: never). */
export async function lastBackup(kv) { return (await read(kv)).at ?? 0; }

/** Is a reminder due? null if not, else { age }: the days since the last backup file, or null
 *  if none was ever saved. Counting starts the first time there is something to lose, so a
 *  person is not asked the moment they update the app. */
export async function backupDue({ kv, settings, hasHistory, folderOn, now = Date.now() }) {
  const days = settings.backupReminderDays;
  if (!(days > 0) || folderOn || !hasHistory) return null;
  let note = await read(kv);
  if (!note.since) {
    note = { ...note, since: now };
    await kv.put('backup', note);
  }
  if (now - Math.max(note.at ?? 0, note.since) < days * DAY || now < (note.later ?? 0)) return null;
  return { age: note.at ? Math.floor((now - note.at) / DAY) : null };
}
