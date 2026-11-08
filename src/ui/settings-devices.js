// The devices page of the settings: link a second device (main device: answer its code; new
// device: make a code) and the list of linked devices, with their names and "Unlink".
import { suggestAlias } from '../chat/device-sync.js';
import { ALIAS_MAX } from '../chat/envelope.js';
import { h } from './dom.js';
import { t } from './i18n.js';
import { applyBar } from './settings-shell.js';

export class DevicesPage {
  constructor(ui) { this.ui = ui; }

  render() {
    const { model } = this.ui;
    const holder = h('div'); // the list of devices; drawn again when one is added or removed
    let save = async () => {};
    const bar = applyBar(() => save(), () => draw());
    const draw = () => {
      const section = this.#list(draw);
      save = section.save;
      holder.replaceChildren(...section.nodes);
      bar.hide();
    };
    draw();
    bar.watch(holder);
    return model.isLinked
      ? h('div', {}, h('p', {}, t('linkIntro')),
        h('p', {}, t('linkedTo', { id: model.identity.member.slice(0, 4) })),
        holder, bar.node, this.#separate())
      : h('div', {}, h('p', {}, t('linkIntro')),
        h('section', {}, h('h3', {}, t('devicesYours')), holder, bar.node),
        h('section', {}, h('h3', {}, t('linkNew')), h('p', {}, t('linkNewHelp')),
          this.#linkNewDevice(draw)),
        h('section', {}, h('h3', {}, t('linkThis')), h('p', {}, t('linkThisHelp')),
          this.#linkThisDevice()));
  }

  /** The devices with their aliases, and what Apply does with the names typed there. */
  #list(draw) {
    const { model } = this.ui;
    if (!model.isLinked && model.deviceRows().length < 2) {
      return { nodes: [h('p', { class: 'muted' }, t('devicesNone'))], save: async () => {} };
    }
    const list = this.#deviceList(draw);
    const save = async () => {
      try {
        await list.save();
        this.ui.notify(t('devicesSaved'));
        draw(); // from what is saved now
      } catch (err) { this.ui.notify(t('badSettings', { why: err.message })); }
    };
    return { nodes: [h('p', { class: 'muted' }, t('deviceAliasHelp')), list.node], save };
  }

  /** All devices of this identity, each with an alias to edit and, except the main device
   *  and this one, an Unlink: any device may do either to any other. */
  #deviceList(draw) {
    const { model } = this.ui;
    const fields = [];
    const node = h('ul', { class: 'devices-list' }, ...model.deviceRows().map((row) => {
      const input = h('input', {
        type: 'text', class: 'device-alias', maxLength: ALIAS_MAX, value: row.alias,
        placeholder: row.main ? t('deviceMain') : '', 'aria-label': t('deviceAlias'),
      });
      fields.push({ row, input });
      return h('li', {}, input,
        row.self ? h('span', { class: 'muted' }, t('deviceThis')) : null,
        !row.main && !row.self ? h('button', {
          class: 'ghost',
          onclick: async () => {
            if (!confirm(t('devicesUnlinkConfirm', { name: row.alias }))) return;
            await model.unlinkDevice(row.pub);
            draw();
          },
        }, t('devicesUnlink')) : null);
    }));
    const save = async () => {
      for (const { row, input } of fields) {
        if (input.value.trim() !== row.alias) await model.setDeviceAlias(row.pub, input.value);
      }
    };
    return { node, save };
  }

  /** A linked device leaves the main device and becomes a device of its own. */
  #separate() {
    return h('p', {}, h('button', {
      class: 'ghost',
      onclick: async () => {
        if (!confirm(t('leaveLinkConfirm'))) return;
        try { await this.ui.model.leaveLink(); } catch (err) { this.ui.notify(err.message); }
      },
    }, t('leaveLink')));
  }

  /** Main device: paste or scan the new device's code, show the answer. */
  #linkNewDevice(onLinked) {
    const result = h('div', { class: 'link-result' });
    const input = this.ui.kit.codeInput(t('linkRequestPlaceholder'), async (text) => {
      try {
        const { code, sas, name } = await this.ui.model.linkDevice(text);
        result.replaceChildren(
          h('p', {}, t('linkGrantHelp', { name })), h('p', { class: 'sas-line' },
            h('strong', { class: 'sas' }, sas)),
          this.ui.kit.copyField(code, 4), this.ui.kit.qr(code),
        );
        input.area.value = ''; // the next code must not be pasted behind this one
        onLinked?.(); // the new device is in the list now
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
}
