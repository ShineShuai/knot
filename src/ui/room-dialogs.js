// Dialogs about one room or the room list: new, rename, recovery code, invite, members,
// export and leave. The page (view.js) opens them; they use its public parts (`ui`).
import { toB64u } from '../util/bytes.js';
import { decodeCode } from '../net/handshake.js';
import { nextRoomName } from '../app.js';
import { h, safeFileName } from './dom.js';
import { t } from './i18n.js';
import { exportJson, exportText } from './export.js';

const roomLink = (room) => `${location.origin}${location.pathname}#r=${toB64u(room.secret)}`;

export class RoomDialogs {
  #codes = new Set(); // rooms for which a recovery code is being made right now

  constructor(ui) {
    this.ui = ui;
  }

  /** Nothing is created until the button is pressed: Cancel or Close leave things as they were. */
  newRoom() {
    this.#nameDialog({
      title: t('newRoom'), button: t('createRoom'), value: this.#freeRoomName(),
      onSave: (name) => this.#createRoom(name),
    });
  }

  #freeRoomName() {
    return nextRoomName([...this.ui.model.rooms.values()].map((r) => r.label), t('roomDefault'));
  }

  rename(room) {
    this.#nameDialog({
      title: t('renameRoom'), button: t('save'), value: room.label || this.#freeRoomName(),
      onSave: async (name) => {
        await this.ui.model.renameRoom(room.id, name);
        this.ui.dialog.close();
        if (room === this.ui.current) this.ui.renderStage();
      },
    });
  }

  /** A one-field dialog: a name, then the action button. Enter works like the button. */
  #nameDialog({ title, value, button, onSave }) {
    const input = h('input', { type: 'text', maxLength: 40, value });
    const footer = this.ui.kit.footer({ save: button, onSave: () => go() });
    const save = footer.primary;
    const go = async () => {
      if (save.disabled) return; // a double click must not do it twice
      save.disabled = true;
      try { await onSave(input.value); } catch (err) {
        this.ui.notify(err.message);
        save.disabled = false;
      }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) go(); });
    this.ui.kit.open(title, h('label', { class: 'field' }, t('roomName'), input), footer);
    input.focus?.();
    input.select?.();
  }

  async #createRoom(name) {
    const label = name.trim().slice(0, 40) || this.#freeRoomName();
    let room;
    try { room = await this.ui.model.createRoom(label); } catch (err) {
      this.ui.dialog.close();
      return this.ui.notify(err.message);
    }
    this.ui.select(room);
    return this.ensureRecovery(room, () => this.invite(room));
  }

  /** The owner needs a recovery code: make one and show it once. `force`: replace the old. */
  async ensureRecovery(room, after = null, force = false) {
    const needed = room.isOwner && (force || !room.roster.recoveryKey) && !this.#codes.has(room);
    if (!needed) { after?.(); return; }
    this.#codes.add(room);
    try {
      this.#recoveryDialog(await room.newRecoveryCode(), after);
    } catch (err) {
      this.ui.notify(err.message);
      after?.();
    } finally { this.#codes.delete(room); }
  }

  #recoveryDialog(code, after) {
    this.ui.kit.open(t('recoveryTitle'),
      h('p', {}, t('recoveryHelp')),
      this.ui.kit.copyField(code),
      this.ui.kit.footer({ save: t('recoverySaved'), onSave: () => this.ui.dialog.close() }));
    if (after) this.ui.dialog.addEventListener('close', after, { once: true });
  }

  exportHistory(room) {
    const save = (extension, content, type) => () => (
      this.#download(room, extension, content(room), type)
    );
    this.ui.kit.open(t('exportHistory'),
      h('p', {}, t('exportHelp', { n: room.log.size })),
      this.ui.kit.footer({
        save: t('exportText'), onSave: save('txt', exportText, 'text/plain'),
        extra: [h('button', { onclick: save('json', exportJson, 'application/json') },
          t('exportJson'))],
      }));
  }

  #download(room, extension, content, type) {
    const day = new Date().toISOString().slice(0, 10);
    const name = safeFileName(`knot-${room.label || t('roomDefault')}-${day}.${extension}`);
    const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
    h('a', { href: url, download: name }).click();
    const timer = setTimeout(() => URL.revokeObjectURL(url), 10_000);
    timer.unref?.();
  }

  invite(room) {
    const pair = h('div', { class: 'pair' });
    const make = h('button', {
      onclick: async () => {
        make.disabled = true;
        try {
          const { code } = await room.createInvite();
          const sas = h('p', { class: 'sas-line' });
          const reply = this.ui.kit.codeInput(t('replyPlaceholder'), async (text) => {
            const answer = decodeCode(text);
            if (answer?.kind !== 'answer') return this.ui.notify(t('invalidCode'));
            try { await room.acceptAnswer(answer); } catch (err) { this.ui.notify(err.message); }
          });
          const off = room.on('peers', (list) => {
            const p = list.find((x) => x.via === 'manual' && x.sas);
            sas.replaceChildren(
              ...(
                p ? [
                  t('verify'),
                  ' ',
                  h('strong', { class: 'sas' }, p.sas),
                  ' · ',
                  p.state === 'p2p' ? t('connected') : t('connecting'),
                ] : []
              )
            );
          });
          this.ui.dialog.addEventListener('close', off, { once: true });
          pair.replaceChildren(this.ui.kit.copyField(code, 4), this.ui.kit.qr(code), reply.node,
            h('button', { class: 'primary', onclick: reply.submit }, t('connect')), sas);
        } catch (err) { this.ui.notify(err.message); make.disabled = false; }
      },
    }, t('createCode'));
    pair.append(make);
    const link = h('div');
    const owned = !!room.roster;
    (owned ? room.joinLinkParts().then(
      ({ lobbySecret, ownerId }) => `${location.origin}${location.pathname}#j=${
        toB64u(lobbySecret)}.${ownerId}`,
    ) : Promise.resolve(roomLink(room))).then(
      (url) => link.replaceChildren(this.ui.kit.copyField(url)),
    );
    const help = !owned ? 'linkHelp' : room.isOwner ? 'joinLinkHelpOwner' : 'joinLinkHelp';
    this.ui.kit.open(t('invite'),
      h('section', {}, h('h3', {}, t(owned ? 'joinLinkTitle' : 'linkTitle')),
        h('p', {}, t(help)), link),
      !owned || room.isOwner
        ? h('section', {}, h('h3', {}, t('pairTitle')), h('p', {}, t('pairHelp')), pair)
        : null);
  }

  /** Members, and for the owner: join requests, removal and handing the room over. */
  members(room) {
    const body = h('div', { class: 'members' });
    const run = (job) => job.catch((err) => this.ui.notify(err.message));
    const draw = () => {
      const states = { p2p: 'direct', relay: 'relay', seen: 'seen', connecting: 'connecting' };
      const rows = room.membersView().map((m) => h('li', { class: 'member' },
        h('span', { class: 'member-name' }, m.name,
          m.owner ? h('span', { class: 'badge' }, t('ownerBadge')) : null),
        h('span', { class: 'file-size' }, m.self ? t('you') : t(states[m.state] ?? 'offlineState')),
        room.isOwner && !m.self ? h('span', { class: 'imgact' },
          h('button', {
            onclick: () => confirm(t('removeConfirm', { name: m.name }))
              && run(room.removeMember(m.id)),
          }, t('removeMember')),
          h('button', {
            onclick: () => confirm(t('transferConfirm', { name: m.name }))
              && run(room.transferOwnership(m.id)),
          }, t('makeOwner'))) : null));
      const asks = room.joinRequests.map((r) => h('div', { class: 'request' },
        h('b', {}, r.name), ' ', h('span', { class: 'file-size' }, r.id),
        h('p', { class: 'text' }, r.greeting),
        h('div', { class: 'actions' },
          h('button', { class: 'primary', onclick: () => run(room.approveJoin(r.id)) },
            t('approve')),
          h('button', { onclick: () => run(room.declineJoin(r.id)) }, t('decline')))));
      body.replaceChildren(
        h('ul', { class: 'members-list' }, ...rows),
        ...(room.isOwner ? [h('h3', {}, t('requests')),
          ...(asks.length ? asks : [h('p', { class: 'file-size' }, t('noRequests'))]),
          h('h3', {}, t('recoveryTitle')),
          h('p', { class: 'file-size' },
            room.roster.recoveryKey ? t('recoverySet') : t('recoveryNotSet')),
          h('button', { onclick: () => this.ensureRecovery(room, null, true) },
            t('newRecoveryCode'))] : []));
    };
    draw();
    const offs = ['roster', 'requests', 'peers'].map((name) => room.on(name, draw));
    this.ui.dialog.addEventListener('close', () => offs.forEach((off) => off()), { once: true });
    this.ui.kit.open(t('members'), body);
  }

  /** Leave a room (after asking): its images, staged files and stored messages go. */
  leave(room) {
    if (!confirm(t('leaveConfirm') + (this.ui.model.paired ? `\n${t('leaveOthers')}` : ''))) return;
    this.ui.images.disposeRoom(room.id);
    this.ui.composer.forget(room);
    this.ui.model.removeRoom(room.id).then(() => this.ui.select(null));
  }
}
