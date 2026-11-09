// Settings: one dialog with a list of pages (general, notifications, network, devices, data,
// about), made by SettingsShell. What cannot go wrong applies as soon as it is changed (language,
// name, previews, notifications); the lists that must be right as a whole (network, devices)
// have an Apply bar.
import { SHARED } from '../chat/device-sync.js';
import { keepStorage, storageState } from '../store/persist.js';
import { VERSION } from '../version.js';
import { h } from './dom.js';
import { diagnosticsReport } from './diagnostics.js';
import { LANGUAGES, setLanguage, t } from './i18n.js';
import { DevicesPage } from './settings-devices.js';
import { NetworkPage } from './settings-network.js';
import { SettingsShell, field, switchRow } from './settings-shell.js';

/** Who a page's settings reach: all devices of this person (as the app really shares them), or
 *  only this one. */
const scope = (shared) => (shared ? { text: t('scopeAll'), kind: '' }
  : { text: t('scopeDevice'), kind: 'me' });
const scopeOf = (...keys) => scope(keys.every((k) => SHARED.includes(k)));

export class SettingsDialogs {
  constructor(ui) {
    this.ui = ui;
    this.shell = null;
  }

  /** Open the settings, at `page` (an id below) or at the first one. */
  open(page = null) {
    const { ui } = this;
    this.shell = new SettingsShell(ui.kit);
    this.shell.open(t('settings'), [
      { id: 'general', label: t('settingsGeneral'),
        scope: scopeOf('name', 'language', 'imagePreviews'), render: () => this.#general() },
      ui.notifier.supported ? { id: 'notifications', label: t('settingsNotifications'),
        scope: scopeOf('notifications'), render: () => this.#notifications() } : null,
      { id: 'network', label: t('settingsNetwork'),
        scope: scopeOf('brokers', 'brokersEnabled', 'relayFallback', 'stunServers', 'turnServers'),
        render: (ctx) => new NetworkPage(ui).render(ctx) },
      { id: 'devices', label: t('settingsDevices'), scope: scope(true), // names travel along
        render: () => new DevicesPage(ui).render() },
      { id: 'data', label: t('settingsData'), scope: scope(false), render: () => this.#data() },
      { id: 'about', label: t('settingsAbout'), render: () => this.#about() },
    ].filter(Boolean), page);
  }

  /** The devices page: also where "use this device with your main device" leads. */
  devices() { this.open('devices'); }

  /** Apply one change at once; says why if it is refused. */
  async #save(patch) {
    try {
      await this.ui.model.updateSettings(patch);
      this.ui.notify(t('saved'));
    } catch (err) { this.ui.notify(t('badSettings', { why: err.message })); }
  }

  #general() {
    const s = this.ui.model.settings;
    const name = h('input', { type: 'text', value: s.name, maxLength: 32 });
    name.addEventListener('change', () => this.#save({ name: name.value.trim() }));
    const languages = { auto: t('languageAuto'), ...LANGUAGES };
    const language = h('select', {}, ...Object.entries(languages).map(
      ([value, label]) => h('option', { value, selected: value === s.language }, label),
    ));
    language.addEventListener('change', async () => {
      // the dialog is drawn again in the new language: edits not applied yet would be lost
      if (this.shell.pending && !confirm(t('discardChanges'))) {
        language.value = s.language;
        return;
      }
      try { await this.ui.model.updateSettings({ language: language.value }); } catch (err) {
        this.ui.notify(t('badSettings', { why: err.message }));
        return;
      }
      setLanguage(s.language);
      this.ui.relocalize();
      this.ui.notify(t('saved'));
      this.open(this.shell.current); // this dialog too, in the new language
    });
    const modes = { auto: 'previewAuto', tap: 'previewTap', off: 'previewOff' };
    const previews = h('select', {}, ...Object.entries(modes).map(
      ([value, label]) => h('option', { value, selected: value === s.imagePreviews }, t(label)),
    ));
    previews.addEventListener('change', () => this.#save({ imagePreviews: previews.value }));
    return h('div', {}, field(t('language'), language), field(t('name'), name),
      field(t('imagePreviews'), previews));
  }

  #notifications() {
    const { notifier } = this.ui;
    const on = h('input', {
      type: 'checkbox', role: 'switch', checked: this.ui.model.settings.notifications,
    });
    // what the browser says; the setting can only work while it allows them
    const state = h('p', { role: 'status' });
    const showState = () => {
      state.textContent = t('notifyState', { state: t(`notifyPerm_${notifier.permission}`) });
    };
    on.addEventListener('change', async () => {
      // asking for permission needs this click; if it is refused, the setting stays off
      const allowed = !on.checked || await notifier.enable();
      on.checked = on.checked && allowed;
      showState();
      try {
        await this.ui.model.updateSettings({ notifications: on.checked });
        this.ui.notify(t(allowed ? 'saved' : 'notifyBlocked'));
      } catch (err) { this.ui.notify(t('badSettings', { why: err.message })); }
    });
    showState();
    return h('div', {}, switchRow(t('notifications'), on), state);
  }

  /** Ask the browser to keep our data. The answer is shown on the page itself (a refusal is
   *  explained with what helps, never an error); browsers often refuse without any prompt. */
  #data() {
    const storage = this.ui.opts.storage ?? globalThis.navigator?.storage;
    const kept = h('p', { class: 'storage' });
    const help = h('p', { hidden: true }, t('storageHelp'));
    const result = h('p', { class: 'storage-result', role: 'status' });
    const keep = h('button', { hidden: true, onclick: async () => {
      keep.disabled = true;
      result.textContent = t('storageAsking');
      const granted = await keepStorage(storage);
      keep.disabled = false;
      result.textContent = t(granted ? 'storageGranted' : 'storageDenied');
      showStorage();
    } }, t('storageKeep'));
    const showStorage = async () => {
      const state = await storageState(storage);
      const atRisk = state.supported && !state.persisted;
      kept.textContent = t(!state.supported ? 'storageUnsupported'
        : state.persisted ? 'storageKept' : 'storageAtRisk');
      keep.hidden = help.hidden = !atRisk;
    };
    showStorage();
    return h('div', { class: 'storage-box' }, h('p', {}, t('storageWhy')), kept, help, keep,
      result);
  }

  /** The version, and what this browser supports and how the links look: to paste when
   *  something fails. */
  #about() {
    const report = h('div');
    const show = h('button', { onclick: async () => {
      const env = this.ui.opts.diagnosticsEnv ?? globalThis;
      report.replaceChildren(this.ui.kit.copyField(await diagnosticsReport(this.ui.model, env)));
    } }, t('diagnostics'));
    return h('div', {}, h('p', {}, `knot v${VERSION}`), h('p', {}, t('diagnosticsHelp')), show,
      report);
  }
}
