// Settings > Devices > Identity recovery (see crypto/identity-recovery.js): the main device
// makes a recovery code, and a new or wiped device takes an identity back with one.
import { MIN_PASSPHRASE } from '../store/backup.js';
import { RecoveryError } from '../crypto/identity-recovery.js';
import { h } from './dom.js';
import { t } from './i18n.js';
import { field } from './settings-shell.js';

const password = (cls) => h('input', {
  type: 'password', class: cls, autocomplete: 'new-password', spellcheck: false,
});

export class RecoverySection {
  constructor(ui) { this.ui = ui; }

  get model() { return this.ui.model; }

  #explain(err) {
    return err instanceof RecoveryError
      ? t(`recoveryErr_${err.code}`, { n: MIN_PASSPHRASE }) : String(err?.message ?? err);
  }

  /** Main device: when the code was made, make a new one, cancel it. */
  make() {
    const { model, ui } = this;
    const status = h('p', { class: 'recovery-status' });
    const buttons = h('div', { class: 'row-buttons' });
    const say = h('p', { class: 'recovery-result', role: 'status' });
    const shown = h('div', { class: 'recovery-shown' }); // the code, until the page is left
    const [pass, again] = [password('recovery-pass'), password('recovery-pass2')];
    const draw = async () => {
      const info = await model.recoveryInfo();
      const stale = info && !info.channel && model.deviceRows().length > 1;
      status.textContent = !info ? t('recoveryNone')
        : t('recoveryOn', { time: new Date(info.ms).toLocaleString() })
          + (stale ? ` ${t('recoveryNoChannel')}` : '');
      const make = h('button', { class: 'primary', onclick: async () => {
        if (pass.value.length < MIN_PASSPHRASE) {
          say.textContent = t('recoveryErr_short_passphrase', { n: MIN_PASSPHRASE });
          return;
        }
        if (pass.value !== again.value) { say.textContent = t('backupMismatch'); return; }
        make.disabled = true;
        try {
          const iterations = ui.opts.backupIterations;
          const code = await model.makeRecoveryCode(pass.value, { iterations });
          pass.value = again.value = '';
          say.textContent = t('recoveryShow');
          shown.replaceChildren(ui.kit.copyField(code, 4), ui.kit.qr(code));
          await draw();
        } catch (err) { say.textContent = this.#explain(err); } finally { make.disabled = false; }
      } }, info ? t('recoveryMakeNew') : t('recoveryMake'));
      const cancel = info && h('button', { class: 'ghost', onclick: async () => {
        if (!(ui.opts.confirm ?? globalThis.confirm)(t('recoveryCancelConfirm'))) return;
        try {
          await model.cancelRecovery();
          shown.replaceChildren();
          say.textContent = t('recoveryCancelled');
          await draw();
        } catch (err) { say.textContent = this.#explain(err); }
      } }, t('recoveryCancel'));
      buttons.replaceChildren(...[make, cancel].filter(Boolean));
    };
    draw();
    return h('div', { class: 'recovery-box' }, h('p', {}, t('idRecoveryHelp')), status,
      field(t('backupPass'), pass), field(t('backupPassAgain'), again), buttons, say, shown);
  }

  /** A device without an identity of its own worth keeping: take one back with a code. */
  restore() {
    const { model, ui } = this;
    const area = h('input', {
      type: 'text', class: 'recovery-code', spellcheck: false, autocomplete: 'off',
      placeholder: t('recoveryCodePlaceholder'),
    });
    const pass = password('recovery-restore-pass');
    const say = h('p', { class: 'recovery-result recovery-restore-result', role: 'status' });
    const button = h('button', { class: 'primary', onclick: async () => {
      if (!(ui.opts.confirm ?? globalThis.confirm)(t('recoveryRestoreConfirm'))) return;
      button.disabled = true;
      try {
        await model.restoreIdentity(area.value, pass.value);
        say.textContent = t('recoveryRestored');
        (ui.opts.reload ?? (() => globalThis.location.reload()))();
      } catch (err) { say.textContent = this.#explain(err); } finally { button.disabled = false; }
    } }, t('recoveryRestore'));
    return h('div', { class: 'recovery-box' }, h('p', {}, t('recoveryRestoreHelp')), area,
      field(t('backupPass'), pass), button, say);
  }
}
