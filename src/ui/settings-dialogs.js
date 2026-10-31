// Settings, linked devices and the diagnostics report.
import { suggestAlias } from '../chat/device-sync.js';
import { ALIAS_MAX } from '../chat/envelope.js';
import { keepStorage, storageState } from '../store/persist.js';
import { h } from './dom.js';
import { diagnosticsReport } from './diagnostics.js';
import { LANGUAGES, setLanguage, t } from './i18n.js';

export class SettingsDialogs {
  constructor(ui) {
    this.ui = ui;
  }

  /** Link a second device (main device: answer its code; new device: make a code), and the
   *  list of linked devices with "Unlink". */
  async devices() {
    const { model } = this.ui;
    const linked = await model.linkedDevices();
    const parts = [];
    if (model.isLinked) {
      parts.push(h('p', {}, t('linkedTo', { id: model.identity.member.slice(0, 4) })),
        h('p', { class: 'muted' }, t('deviceAliasHelp')), this.#deviceList(false));
    } else {
      parts.push(h('h3', {}, t('devices')), linked.length ? h('div', {},
        h('p', { class: 'muted' }, t('deviceAliasHelp')), this.#deviceList(true))
        : h('p', { class: 'muted' }, t('devicesNone')),
      h('h3', {}, t('linkNew')), h('p', {}, t('linkNewHelp')), this.#linkNewDevice());
      parts.push(h('h3', {}, t('linkThis')), h('p', {}, t('linkThisHelp')), this.#linkThisDevice());
    }
    this.ui.kit.open(t('devices'), ...parts);
  }

  /** All devices of this identity, each with an alias to edit (any device may rename any).
   *  Only the main device can unlink. */
  #deviceList(canUnlink) {
    const { model } = this.ui;
    return h('ul', { class: 'devices-list' }, ...model.deviceRows().map((row) => {
      const input = h('input', {
        type: 'text', class: 'device-alias', maxLength: ALIAS_MAX, value: row.alias,
        placeholder: row.main ? t('deviceMain') : '', 'aria-label': t('deviceAlias'),
      });
      input.addEventListener('change', async () => {
        try { input.value = await model.setDeviceAlias(row.pub, input.value); } catch (err) {
          input.value = row.alias;
          this.ui.notify(t('badSettings', { why: err.message }));
        }
      });
      return h('li', {}, input,
        row.self ? h('span', { class: 'muted' }, t('deviceThis')) : null,
        canUnlink && !row.main ? h('button', {
          class: 'ghost',
          onclick: async () => {
            if (!confirm(t('devicesUnlinkConfirm', { name: row.alias }))) return;
            await model.unlinkDevice(row.pub);
            this.devices();
          },
        }, t('devicesUnlink')) : null);
    }));
  }

  /** Main device: paste or scan the new device's code, show the answer. */
  #linkNewDevice() {
    const result = h('div', { class: 'link-result' });
    const input = this.ui.kit.codeInput(t('linkRequestPlaceholder'), async (text) => {
      try {
        const { code, sas, name } = await this.ui.model.linkDevice(text);
        result.replaceChildren(
          h('p', {}, t('linkGrantHelp', { name })), h('p', { class: 'sas-line' },
            h('strong', { class: 'sas' }, sas)),
          this.ui.kit.copyField(code, 4), this.ui.kit.qr(code),
        );
      } catch (err) { this.ui.notify(err.message); }
    });
    return h('div', {}, input.node,
      h('button', { class: 'primary', onclick: input.submit }, t('linkMake')), result);
  }

  /** New device: show our code, take the main device's answer, confirm, apply. */
  #linkThisDevice() {
    const area = h('div', { class: 'link-result' });
    const name = h('input', {
      type: 'text', maxLength: ALIAS_MAX, value: suggestAlias() ?? '',
      placeholder: t('linkDeviceName'),
    });
    const start = h('button', {
      onclick: async () => {
        start.disabled = true;
        try {
          const { code, read } = await this.ui.model.startLinking(name.value.trim());
          const confirmBox = h('div');
          const reply = this.ui.kit.codeInput(t('linkGrantPlaceholder'), async (text) => {
            const grant = await read(text);
            if (!grant) return this.ui.notify(t('linkInvalid'));
            return confirmBox.replaceChildren(
              h('p', {}, t('linkConfirm', { id: grant.mainId.slice(0, 4), rooms: grant.rooms })),
              h('p', { class: 'sas-line' }, h('strong', { class: 'sas' }, grant.sas)),
              h('button', {
                class: 'primary',
                onclick: async () => {
                  if (!confirm(t('linkWarn'))) return;
                  await grant.apply();
                  this.ui.notify(t('linkDone'));
                  location.reload();
                },
              }, t('linkDo')),
            );
          });
          area.replaceChildren(this.ui.kit.copyField(code, 4), this.ui.kit.qr(code), reply.node,
            h('button', { onclick: reply.submit }, t('connect')), confirmBox);
        } catch (err) { this.ui.notify(err.message); start.disabled = false; }
      },
    }, t('linkMakeCode'));
    return h('div', {}, name, start, area);
  }

  /** What this browser supports and how the links look: to paste when something fails. */
  async diagnostics() {
    const text = await diagnosticsReport(this.ui.model, this.ui.opts.diagnosticsEnv ?? globalThis);
    const { kit } = this.ui;
    kit.open(t('diagnostics'), h('p', {}, t('diagnosticsHelp')), kit.copyField(text));
  }

  open() {
    const s = this.ui.model.settings;
    const name = h('input', { type: 'text', value: s.name, maxLength: 32 });
    const languages = { auto: t('languageAuto'), ...LANGUAGES };
    const language = h('select', {}, ...Object.entries(languages).map(
      ([value, label]) => h('option', { value, selected: value === s.language }, label),
    ));
    const stun = h('textarea', { class: 'code', rows: 4, value: s.stunServers.join('\n') });
    const turn = h('textarea', { class: 'code', rows: 3, value: JSON.stringify(s.turnServers) });
    const brokers = h('textarea', { class: 'code', rows: 3, value: s.brokers.join('\n') });
    const useBrokers = h('input', { type: 'checkbox', checked: s.brokersEnabled });
    const health = this.ui.model.brokerHealth;
    const brokerRows = h('ul', { class: 'broker-health' });
    const showBrokers = () => brokerRows.replaceChildren(...(health?.rows(
      brokers.value.split('\n').map((l) => l.trim()).filter(Boolean),
    ) ?? []).map((r) => h('li', { class: r.ok ? 'up' : r.ok === false ? 'down' : '' },
      `${r.ok ? '✓' : r.ok === false ? '✗' : '…'} `
      + t(r.ok ? 'brokerUp' : r.ok === false ? 'brokerDown' : 'brokerUnknown', r))));
    const checkBrokers = h('button', { onclick: async () => {
      await health.check(brokers.value.split('\n').map((l) => l.trim()).filter(Boolean));
      showBrokers();
    } }, t('brokerCheck'));
    if (health) {
      showBrokers();
      this.ui.dialog.addEventListener('close', health.on('change', showBrokers), { once: true });
    }
    // Ask the browser to keep our data; a refusal is explained, never an error.
    const storage = this.ui.opts.storage ?? globalThis.navigator?.storage;
    const kept = h('p', { class: 'storage' });
    const keep = h('button', { hidden: true, onclick: async () => {
      if (!(await keepStorage(storage))) this.ui.notify(t('storageDenied'));
      showStorage();
    } }, t('storageKeep'));
    const showStorage = async () => {
      const state = await storageState(storage);
      kept.textContent = !state.supported ? ''
        : t(state.persisted ? 'storageKept' : 'storageAtRisk');
      keep.hidden = !state.supported || state.persisted;
    };
    showStorage();
    const relay = h('input', { type: 'checkbox', checked: s.relayFallback });
    const notifications = h('input', { type: 'checkbox', checked: s.notifications });
    const modes = { auto: 'previewAuto', tap: 'previewTap', off: 'previewOff' };
    const previews = h('select', {}, ...Object.entries(modes).map(
      ([value, label]) => h('option', { value, selected: value === s.imagePreviews }, t(label)),
    ));
    const lines = (el) => el.value.split('\n').map((l) => l.trim()).filter(Boolean);
    const save = async () => {
      try {
        const stunList = lines(stun), brokerList = lines(brokers), turnList = JSON.parse(
          turn.value || '[]',
        );
        if (!stunList.every((u) => /^stuns?:/.test(u))) throw new Error(
          'STUN URLs start with stun:',
        );
        if (!brokerList.every((u) => u.startsWith('wss://'))) throw new Error(
          'brokers must use wss://',
        );
        if (!Array.isArray(turnList)) throw new Error('TURN must be a JSON list');
        const languageChanged = language.value !== s.language;
        // asking for permission needs this click; if it is refused, the setting stays off
        const allowed = !notifications.checked || await this.ui.notifier.enable();
        await this.ui.model.updateSettings({
          name: name.value.trim(),
          language: language.value,
          stunServers: stunList,
          turnServers: turnList,
          brokers: brokerList,
          brokersEnabled: useBrokers.checked,
          relayFallback: relay.checked,
          notifications: notifications.checked && allowed,
          imagePreviews: previews.value,
        });
        if (languageChanged) { setLanguage(s.language); this.ui.relocalize(); }
        this.ui.notify(t(allowed ? 'saved' : 'notifyBlocked'));
        this.ui.dialog.close();
      } catch (err) { this.ui.notify(t('badSettings', { why: err.message })); }
    };
    const field = (label, control) => h(
      'label',
      { class: 'field' },
      h('span', {}, label),
      control,
    );
    const check = (label, control) => h(
      'label',
      { class: 'check' },
      control,
      h('span', {}, label),
    );
    this.ui.kit.open(
      t('settings'),
      field(t('language'), language),
      field(t('name'), name),
      field(t('stun'), stun),
      field(t('turn'), turn),
      field(t('brokerList'), brokers),
      health ? h('div', { class: 'field' }, brokerRows, checkBrokers) : null,
      check(t('useBrokers'), useBrokers),
      check(t('relayText'), relay),
      this.ui.notifier.supported ? check(t('notifications'), notifications) : null,
      h('div', { class: 'field' }, kept, keep),
      h('div', { class: 'field' },
        h('button', { onclick: () => this.devices() }, t('devices')),
        h('button', { onclick: () => this.diagnostics() }, t('diagnostics'))),
      field(t('imagePreviews'), previews),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'primary', onclick: save }, t('saveSettings')),
        h('a', { class: 'button', href: 'lab/lab.html' }, t('lab')),
      ),
    );
  }
}
