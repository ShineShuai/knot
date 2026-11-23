// Settings > Data > Backup: save an encrypted backup file, restore one. Everything happens on
// the page itself (a dialog cannot open another one); the file never leaves the device.
import {
  BackupError, FILE_EXT, ITERATIONS, MIN_PASSPHRASE, backupSecret, collect, countOf, open, restore,
  seal,
} from '../store/backup.js';
import { h } from './dom.js';
import { t } from './i18n.js';
import { field } from './settings-shell.js';

/** Hand `bytes` to the person as a file to save. */
export function saveFile(name, bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const link = h('a', { href: url, download: name });
  document.body?.append(link); // some browsers want the link in the page
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const password = (cls) => h('input', {
  type: 'password', class: cls, autocomplete: 'new-password', spellcheck: false,
});

export class BackupSection {
  constructor(ui) {
    this.ui = ui;
    this.say = h('p', { class: 'backup-result', role: 'status' });
  }

  get kv() { return this.ui.model.kv; }

  render() {
    return h('section', { class: 'backup-box' }, h('h4', {}, t('backupTitle')),
      h('p', {}, t('backupWhy')), this.#saveForm(), this.#restoreForm(), this.say);
  }

  /** Run `job` with `button` off and a note on the page; a failure is explained, not thrown. */
  async #busy(button, job) {
    button.disabled = true;
    this.say.textContent = t('backupWorking');
    try { await job(); } catch (err) {
      this.say.textContent = t(`backupErr_${err instanceof BackupError ? err.code : 'damaged'}`);
    } finally { button.disabled = false; }
  }

  #saveForm() {
    const [pass, again] = [password('backup-pass'), password('backup-pass2')];
    const button = h('button', { class: 'primary', onclick: () => this.#busy(button, async () => {
      if (pass.value.length < MIN_PASSPHRASE) {
        this.say.textContent = t('backupShort', { n: MIN_PASSPHRASE });
        return;
      }
      if (pass.value !== again.value) { this.say.textContent = t('backupMismatch'); return; }
      const snapshot = await collect(this.kv);
      const counts = countOf(snapshot);
      if (!counts.rooms) { this.say.textContent = t('backupEmpty'); return; }
      const iterations = this.ui.opts.backupIterations ?? ITERATIONS;
      const bytes = await seal(snapshot, await backupSecret(pass.value, { iterations }));
      const name = `knot-backup-${dayOf(snapshot.at)}${FILE_EXT}`;
      (this.ui.opts.saveFile ?? saveFile)(name, bytes);
      this.say.textContent = t('backupSaved', { name, ...counts });
      pass.value = again.value = '';
    }) }, t('backupSave'));
    return h('div', { class: 'backup-save' }, field(t('backupPass'), pass),
      field(t('backupPassAgain'), again), button);
  }

  #restoreForm() {
    const file = h('input', { type: 'file', class: 'backup-file', accept: FILE_EXT });
    const pass = password('backup-restore-pass');
    const button = h('button', { onclick: () => this.#busy(button, async () => {
      const chosen = file.files?.[0];
      if (!chosen) { this.say.textContent = t('backupPickFile'); return; }
      const snapshot = await open(new Uint8Array(await chosen.arrayBuffer()), pass.value);
      const done = await restore(this.kv, snapshot);
      this.say.textContent = t('backupRestored', done);
      (this.ui.opts.reload ?? (() => globalThis.location.reload()))();
    }) }, t('backupRestore'));
    return h('div', { class: 'backup-restore' }, field(t('backupFile'), file),
      field(t('backupPass'), pass), button);
  }
}
