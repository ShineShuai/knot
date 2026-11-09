// Room settings: one dialog per room (the ⚙ in its header), made by SettingsShell like the
// app's Settings. Pages: Overview, Members (rooms with an owner), My preferences, Leave room.
// What is only this person's (the name, mute, previews) applies at once.
import { plain } from '../util/text.js';
import { h } from './dom.js';
import { t } from './i18n.js';
import { SettingsShell, applyBar, field, switchRow } from './settings-shell.js';

const PREVIEWS = { auto: 'previewAuto', tap: 'previewTap', off: 'previewOff' };

export class RoomSettings {
  constructor(ui) {
    this.ui = ui;
    this.shell = null;
  }

  /** Open the settings of `room`, at `page` or at the first one. */
  open(room, page = null) {
    const only = (text) => ({ text, kind: 'me' });
    const shared = { text: t('scopeRoom'), kind: 'room' }; // what everyone in the room is bound by
    const requests = () => (
      room.isOwner ? room.joinRequests.length + room.waitingSenders.length : 0
    );
    this.shell = new SettingsShell(this.ui.kit);
    this.shell.open(t('roomSettingsTitle', { name: room.title || t('roomDefault') }), [
      { id: 'overview', label: t('roomOverview'), scope: only(t('scopeNameYou')),
        render: () => this.#overview(room) },
      room.roster ? { id: 'members', label: t('members'), badge: requests,
        render: () => this.#members(room) } : null,
      room.roster ? { id: 'rules', label: t('roomRules'), scope: shared,
        render: (ctx) => this.#rules(room, ctx) } : null,
      { id: 'prefs', label: t('roomPrefs'), scope: only(t('scopeYou')),
        render: () => this.#prefs(room) },
      { id: 'leave', label: t('leave'), danger: true, render: () => this.#leave(room) },
    ].filter(Boolean), page);
    // the count beside Members follows the people waiting to get in
    const offs = ['requests', 'roster', 'pending'].map(
      (event) => room.on(event, () => this.shell.updateBadges()),
    );
    this.ui.dialog.addEventListener('close', () => offs.forEach((off) => off()), { once: true });
  }

  async #save(room, patch) {
    try {
      await this.ui.model.setRoomPrefs(room.id, patch);
      this.ui.notify(t('saved'));
    } catch (err) { this.ui.notify(t('badSettings', { why: err.message })); }
  }

  #overview(room) {
    const { ui } = this;
    // Our own name for the room; without one, the owner's (if any), else the first.
    const name = h('input', {
      type: 'text', maxLength: 40, value: room.prefs.name ?? '',
      placeholder: room.policy.rules.name || room.label,
    });
    name.addEventListener('change', async () => {
      try {
        await ui.model.setRoomPrefs(room.id, { name: plain(name.value).slice(0, 40) || null });
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
    return h('div', {}, field(t('roomNameMine'), name), h('p', {}, t('roomNameHint')),
      h('dl', { class: 'kv' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      room.roster ? null : h('section', {}, h('h3', {}, t('moveTitle')), h('p', {}, t('moveHelp')),
        h('button', { onclick: () => ui.roomDialogs.moveToOwned(room) }, t('moveButton'))));
  }

  #members(room) {
    const { roomDialogs } = this.ui;
    return h('div', {}, roomDialogs.membersPanel(room, () => this.open(room, 'members')),
      room.rules.join === 'closed' ? h('p', { class: 'err' }, t('rulesJoinClosed')) : null,
      ...roomDialogs.inviteSections(room));
  }

  /** What the owner decided for the room. The owner edits and publishes them together; everyone
   *  else sees them. */
  #rules(room, { refresh }) {
    const { ui } = this;
    const mine = room.isOwner;
    const { rules } = room;
    const older = room.appGaps.older.map(plain); // online, and their app does not know the rules
    /** A choice of one value: a row of radio buttons. */
    const seg = (name, label, value, choices) => {
      const inputs = Object.keys(choices).map((key) => h('input', {
        type: 'radio', name: `${name}-${room.id}`, value: key, checked: key === value,
        disabled: !mine,
      }));
      const labels = Object.values(choices).map((text, i) => h('label', {}, inputs[i],
        h('span', {}, text)));
      return {
        inputs,
        node: h('div', { class: 'field' }, h('span', {}, label),
          h('div', { class: 'seg', role: 'radiogroup' }, ...labels)),
        value: () => inputs.find((i) => i.checked)?.value ?? value,
      };
    };
    const join = seg('join', t('ruleJoin'), rules.join,
      { approve: t('ruleJoinApprove'), closed: t('ruleJoinClosed') });
    const post = seg('post', t('rulePost'), rules.post,
      { all: t('rulePostAll'), owner: t('rulePostOwner') });
    const box = (checked) => h('input', {
      type: 'checkbox', role: 'switch', checked, disabled: !mine,
    });
    const [files, calls, ownerDelete] = [rules.files, rules.calls, rules.ownerDelete].map(box);
    const name = h('input', { type: 'text', maxLength: 32, value: rules.name, disabled: !mine });
    const sizes = [...new Set([0, 1, 5, 25, 100, rules.maxFileMb])].sort((a, b) => a - b);
    const size = h('select', { disabled: !mine }, ...sizes.map((mb) => h('option', {
      value: String(mb), selected: mb === rules.maxFileMb,
    }, t(mb ? 'ruleFileMaxN' : 'ruleFileMaxNone', { n: mb }))));
    const read = () => ({
      join: join.value(), post: post.value(), files: files.checked, calls: calls.checked,
      name: plain(name.value).slice(0, 32), ownerDelete: ownerDelete.checked,
      maxFileMb: Number(size.value),
    });
    const bar = applyBar(async () => {
      try {
        await room.setRules(read());
        ui.notify(t('rulesPublished'));
        bar.hide();
      } catch (err) { ui.notify(t('badSettings', { why: err.message })); }
    }, refresh, t('rulesPublish'));
    for (const el of [...join.inputs, ...post.inputs, files, calls, ownerDelete, size]) {
      el.addEventListener('change', bar.show);
    }
    name.addEventListener('input', bar.show);
    ui.dialog.addEventListener('close', room.on('policy', refresh), { once: true });
    return h('div', {},
      mine ? null : h('p', {}, t('rulesBy', { name: plain(room.ownerName) })),
      field(t('ruleName'), name), h('p', {}, t('ruleNameHint')),
      join.node, post.node, switchRow(t('ruleFiles'), files), field(t('ruleFileMax'), size),
      switchRow(t('ruleCalls'), calls),
      switchRow(t('ruleOwnerDelete'), ownerDelete, t('ruleOwnerDeleteHint')),
      h('p', {}, t('rulesNote')),
      older.length ? h('p', { class: 'warn' }, t('rulesOlder', { names: older.join(', ') })) : null,
      mine ? h('div', {}, bar.node,
        room.policy.rev ? h('p', { class: 'hint' }, t('rulesRev', { n: room.policy.rev })) : null)
        : null);
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
