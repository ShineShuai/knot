// The bar that asks for a backup file now and then (see store/reminder.js): at the top, above
// the rooms, with the button that gets it done.
import { backupDue, snooze } from '../store/reminder.js';
import { h } from './dom.js';
import { t } from './i18n.js';

const CHECK_MS = 6 * 3_600_000;

export class BackupBar {
  constructor(ui) {
    this.ui = ui;
    this.node = h('div', { class: 'update-bar', role: 'status', hidden: true });
  }

  /** Look now, when the page comes back to the screen, and every few hours it stays open. */
  start() {
    this.check();
    const timer = setInterval(() => this.check(), CHECK_MS);
    timer.unref?.();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.check(); });
  }

  async check() {
    const { model, opts } = this.ui;
    let due = null;
    try {
      due = await backupDue({
        kv: model.kv, settings: model.settings, folderOn: !!opts.folder?.active,
        hasHistory: [...model.rooms.values()].some((room) => room.log.list().length > 0),
        now: opts.now?.() ?? Date.now(),
      });
    } catch { /* trouble with the store: no nagging on top of it */ }
    this.node.hidden = !due;
    if (!due) return;
    this.node.replaceChildren(
      h('span', {}, due.age == null ? t('backupDueNever') : t('backupDueDays', { days: due.age })),
      h('button', { class: 'primary', onclick: () => this.ui.settingsDialogs.open('data') },
        t('backupBarSave')),
      h('button', { class: 'ghost', onclick: async () => {
        await snooze(model.kv, opts.now?.() ?? Date.now());
        this.check();
      } }, t('backupBarLater')),
    );
  }
}
