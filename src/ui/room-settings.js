// Room settings: one dialog per room (the ⚙ in its header), made by SettingsShell like the
// app's Settings. Pages: Overview, Members (rooms with an owner), My preferences, Leave room.
// What is only this person's (the name, mute, previews) applies at once.
import { plain } from '../util/text.js';
import { h } from './dom.js';
import { t } from './i18n.js';
import { SettingsShell, field, switchRow } from './settings-shell.js';

const PREVIEWS = { auto: 'previewAuto', tap: 'previewTap', off: 'previewOff' };

export class RoomSettings {
  constructor(ui) {
    this.ui = ui;
    this.shell = null;
  }

  /** Open the settings of `room`, at `page` or at the first one. */
  open(room, page = null) {
    const only = (text) => ({ text, kind: 'me' });
    const requests = room.isOwner ? room.joinRequests.length + room.waitingSenders.length : 0;
    this.shell = new SettingsShell(this.ui.kit);
    this.shell.open(t('roomSettingsTitle', { name: room.label || t('roomDefault') }), [
      { id: 'overview', label: t('roomOverview'), scope: only(t('scopeNameYou')),
        render: () => this.#overview(room) },
      room.roster ? { id: 'members', label: t('members'), badge: requests,
        render: () => this.#members(room) } : null,
      { id: 'prefs', label: t('roomPrefs'), scope: only(t('scopeYou')),
        render: () => this.#prefs(room) },
      { id: 'leave', label: t('leave'), danger: true, render: () => this.#leave(room) },
    ].filter(Boolean), page);
  }

  async #save(room, patch) {
    try {
      await this.ui.model.setRoomPrefs(room.id, patch);
      this.ui.notify(t('saved'));
    } catch (err) { this.ui.notify(t('badSettings', { why: err.message })); }
  }

  #overview(room) {
    const { ui } = this;
    const name = h('input', { type: 'text', maxLength: 40, value: room.label });
    name.addEventListener('change', async () => {
      if (!name.value.trim()) { name.value = room.label; return; } // a room needs a name
      try {
        await ui.model.renameRoom(room.id, name.value);
        if (room === ui.current) ui.renderStage();
        ui.notify(t('saved'));
      } catch (err) { ui.notify(t('badSettings', { why: err.message })); }
    });
    const members = room.membersView();
    const owner = members.find((m) => m.owner);
    const role = !room.roster ? 'roleOpen' : room.isOwner ? 'roleOwner' : 'roleMember';
    const rows = [
      [t('roleLabel'), t(role)],
      ...(room.roster ? [
        [t('ownerLabel'), owner.self ? t('you') : plain(owner.name)],
        [t('members'), String(members.length)],
      ] : []),
    ];
    return h('div', {}, field(t('roomName'), name), h('p', {}, t('roomNameHint')),
      h('dl', { class: 'kv' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])));
  }

  #members(room) {
    const { roomDialogs } = this.ui;
    return h('div', {}, roomDialogs.membersPanel(room, () => this.open(room, 'members')),
      ...roomDialogs.inviteSections(room));
  }

  #prefs(room) {
    const { ui } = this;
    const mute = h('input', { type: 'checkbox', role: 'switch', checked: room.muted });
    mute.addEventListener('change', () => this.#save(room, { mute: mute.checked }));
    const app = t(PREVIEWS[room.settings.imagePreviews]);
    const choices = { inherit: t('previewInherit', { mode: app }),
      ...Object.fromEntries(Object.entries(PREVIEWS).map(([k, key]) => [k, t(key)])) };
    const previews = h('select', {}, ...Object.entries(choices).map(([value, label]) => h(
      'option', { value, selected: value === (room.prefs.previews ?? 'inherit') }, label)));
    previews.addEventListener('change', () => this.#save(
      room, { previews: previews.value === 'inherit' ? null : previews.value },
    ));
    return h('div', {}, switchRow(t('mutePref'), mute, t('muteHint')),
      field(t('previewsRoom'), previews),
      h('div', { class: 'field' }, h('span', {}, t('exportHistory')),
        h('p', {}, t('exportHelp', { n: room.log.size })), ui.roomDialogs.exportButtons(room)));
  }

  #leave(room) {
    return h('div', { class: 'zone' }, h('p', {}, t('leaveRoomHelp')),
      room.isOwner ? h('p', {}, t('leaveOwner')) : null,
      h('button', { class: 'danger', onclick: () => this.ui.roomDialogs.leave(room) },
        t('leave')));
  }
}
