// Settings > Data > Backup: save an encrypted backup file, keep one up to date in a folder
// (Chrome, Edge), restore one. Everything happens on the page itself (a dialog cannot open
// another one); the files never leave the device.
import {
  BackupError, FILE_EXT, ITERATIONS, MIN_PASSPHRASE, backupSecret, collect, countOf, open, restore,
  seal,
} from '../store/backup.js';
import { canPickFolder, keepPrevious, pickFolder, readBackup } from '../store/folder.js';
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
  #pending = null; // a folder that already holds a backup: { handle, old, pass }

  constructor(ui) {
    this.ui = ui;
    this.say = h('p', { class: 'backup-result', role: 'status' });
    this.pass = password('backup-pass');
    this.again = password('backup-pass2');
  }

  get kv() { return this.ui.model.kv; }

  get #iterations() { return this.ui.opts.backupIterations ?? ITERATIONS; }

  render() {
    return h('section', { class: 'backup-box' }, h('h4', {}, t('backupTitle')),
      h('p', {}, t('backupWhy')), field(t('backupPass'), this.pass),
      field(t('backupPassAgain'), this.again), this.#saveButton(), this.#folderBox(),
      this.#restoreForm(), this.say);
  }

  /** Run `job` with `button` off and a note on the page; a failure is explained, not thrown. */
  async #busy(button, job) {
    button.disabled = true;
    this.say.textContent = t('backupWorking');
    try { await job(); } catch (err) {
      this.say.textContent = err instanceof BackupError ? t(`backupErr_${err.code}`)
        : err?.name === 'SecurityError' ? t('folderBlocked')
          : t('backupFailed', { why: err?.name ?? 'error' });
    } finally { button.disabled = false; }
  }

  /** The passphrase typed above if it will do; otherwise says why not. */
  #passphrase() {
    if (this.pass.value.length < MIN_PASSPHRASE) {
      this.say.textContent = t('backupShort', { n: MIN_PASSPHRASE });
      return null;
    }
    if (this.pass.value !== this.again.value) {
      this.say.textContent = t('backupMismatch');
      return null;
    }
    return this.pass.value;
  }

  #saveButton() {
    const button = h('button', { class: 'primary', onclick: () => this.#busy(button, async () => {
      const pass = this.#passphrase();
      if (!pass) return;
      const snapshot = await collect(this.kv);
      const counts = countOf(snapshot);
      if (!counts.rooms) { this.say.textContent = t('backupEmpty'); return; }
      const secret = await backupSecret(pass, { iterations: this.#iterations });
      const name = `knot-backup-${dayOf(snapshot.at)}${FILE_EXT}`;
      (this.ui.opts.saveFile ?? saveFile)(name, await seal(snapshot, secret));
      this.say.textContent = t('backupSaved', { name, ...counts });
      this.pass.value = this.again.value = '';
    }) }, t('backupSave'));
    return button;
  }

  // ---- a folder that is kept up to date (Chrome, Edge) ---------------------------------------

  #folderBox() {
    const box = h('div', { class: 'backup-folder' });
    const draw = () => box.replaceChildren(...this.#folderRows(draw));
    draw();
    return box;
  }

  #folderRows(draw) {
    const { folder } = this.ui.opts;
    const env = this.ui.opts.folderEnv ?? globalThis;
    if (!folder) return [];
    if (!canPickFolder(env)) return [h('p', { class: 'muted' }, t('folderUnsupported'))];
    const button = (label, job, cls = '') => {
      const b = h('button', { class: cls, onclick: () => this.#busy(b, async () => {
        await job();
        draw();
      }) }, label);
      return b;
    };
    if (this.#pending) {
      const { handle, old, pass } = this.#pending;
      const leave = () => { this.#pending = null; };
      return [h('p', {}, t('folderExists')), h('div', { class: 'row-buttons' },
        button(t('folderRestoreIt'), async () => {
          const done = await restore(this.kv, await open(old, pass));
          leave();
          await this.#start(handle, pass);
          this.say.textContent = t('backupRestored', done);
          (this.ui.opts.reload ?? (() => globalThis.location.reload()))();
        }, 'primary'),
        button(t('folderReplaceIt'), async () => {
          await keepPrevious(handle, old);
          leave();
          await this.#start(handle, pass);
        }),
        button(t('cancel'), async () => { leave(); this.say.textContent = ''; }))];
    }
    if (!folder.active) {
      return [h('p', {}, t('folderWhy')), button(t('folderChoose'), async () => {
        const pass = this.#passphrase();
        if (!pass) return;
        const handle = await (this.ui.opts.pickFolder ?? pickFolder)(env);
        if (!handle) { this.say.textContent = ''; return; } // the picker was closed
        const old = await readBackup(handle);
        if (old) this.#pending = { handle, old, pass };
        else await this.#start(handle, pass);
      })];
    }
    const [name, paused] = [folder.name, folder.state === 'needs_permission'];
    const status = folder.state === 'error' ? t('folderError', { name, why: folder.error })
      : paused ? t('folderPaused', { name }) : t('folderOn', {
        name, time: folder.savedAt ? new Date(folder.savedAt).toLocaleString() : t('folderNever'),
      });
    return [h('p', { class: 'backup-folder-state' }, status), h('div', { class: 'row-buttons' },
      paused ? button(t('folderAllow'), () => folder.allow(), 'primary') : null,
      button(t('folderStop'), async () => {
        await folder.disable();
        this.say.textContent = t('folderStopped');
      }))];
  }

  async #start(handle, pass) {
    const { folder } = this.ui.opts;
    await folder.enable(handle, await backupSecret(pass, { iterations: this.#iterations }));
    this.say.textContent = folder.state === 'ok' ? t('folderStarted', { name: folder.name })
      : t('folderFailed', { why: folder.error });
  }

  // ---- restore ---------------------------------------------------------------------------------

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
