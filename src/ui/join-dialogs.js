// Joining a room: by link, by pairing code, by a recovery code, or by asking the owner.
import { fromB64u } from '../util/bytes.js';
import { decodeCode } from '../net/handshake.js';
import { JoinRequest } from '../chat/join.js';
import { MAX_GREETING } from '../chat/lobby.js';
import { h } from './dom.js';
import { t } from './i18n.js';

export class JoinDialogs {
  #joins = new Set(); // join requests still waiting for an owner's answer

  constructor(ui) {
    this.ui = ui;
  }

  /** A recovery code was pasted: reopen the room and claim it once a member is online. */
  async #recoverForm(result, text) {
    const status = h('p', { class: 'sas-line' }, t('recoverWaiting'));
    result.replaceChildren(status);
    try {
      const room = await this.ui.model.recoverRoom(text, t('roomDefault'));
      this.ui.select(room);
      const timer = setTimeout(() => {
        if (room.isOwner) return;
        status.replaceChildren(t('recoverFailed'));
        this.ui.notify(t('recoverFailed'));
      }, 90000);
      timer.unref?.();
      const off = room.on('roster', () => {
        if (!room.isOwner) return;
        off();
        clearTimeout(timer);
        this.ui.notify(t('recoverDone'));
        if (this.ui.dialog.open) this.ui.dialog.close();
      });
    } catch (err) { status.replaceChildren(err.message); }
  }

  /** A join link was opened: write a greeting, then wait for the owner's answer. */
  #greetingForm(result, lobbySecret, ownerId) {
    const greeting = h('textarea', {
      rows: 3, maxLength: MAX_GREETING, placeholder: t('greetingPlaceholder'),
    });
    const status = h('p', { class: 'sas-line' });
    const texts = {
      connecting: 'joinConnecting', waiting: 'joinWaiting', declined: 'joinDeclined',
      offline: 'joinOffline', timeout: 'joinTimeout', approved: 'joinApproved',
    };
    const send = h('button', { class: 'primary' }, t('sendRequest'));
    send.onclick = async () => {
      const text = greeting.value.trim();
      if (!text) return this.ui.notify(t('greetingNeeded'));
      send.disabled = true;
      greeting.disabled = true;
      const { settings, identity, WS } = this.ui.model;
      const ask = new JoinRequest({
        identity, lobbySecret, ownerId, greeting: text, settings, WS,
        name: settings.name || `anon-${identity.id.slice(0, 4)}`,
      });
      this.#joins.add(ask); // keeps knocking even if this dialog is closed
      ask.on('status', (s) => {
        status.replaceChildren(t(texts[s]));
        if (s === 'declined' || s === 'timeout') this.ui.notify(t(texts[s]));
        if (s !== 'connecting' && s !== 'waiting') this.#joins.delete(ask);
      });
      ask.on('approved', async (grant) => {
        try {
          const room = await this.ui.model.completeJoin(grant);
          if (this.ui.dialog.open) this.ui.dialog.close();
          this.ui.select(room);
        } catch (err) { this.ui.notify(err.message); }
      });
      try { await ask.start(); } catch (err) { this.ui.notify(err.message); }
      return undefined;
    };
    result.replaceChildren(h('p', {}, t('greetingHelp')), greeting, send, status);
  }

  open(prefill = '') {
    const result = h('div', { class: 'pair' });
    const handle = async (text) => {
      const lobby = /#j=([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{11})/.exec(text);
      const link = /#r=([A-Za-z0-9_-]{22})/.exec(text);
      const code = text.includes('knot-rk1-') ? null : decodeCode(text);
      try {
        if (text.includes('knot-rk1-')) {
          this.#recoverForm(result, text);
        } else if (lobby) {
          if (lobby[2] === this.ui.model.identity.member) throw new Error(t('ownLink'));
          this.#greetingForm(result, fromB64u(lobby[1]), lobby[2]);
        } else if (link) {
          const room = await this.ui.model.addRoom(fromB64u(link[1]), t('roomDefault'));
          this.ui.dialog.close(); this.ui.select(room);
        } else if (code?.kind === 'offer') {
          const { room, reply } = await this.ui.model.joinOffer(code);
          this.ui.select(room);
          const status = h('p', { class: 'sas-line' }, t('waiting'));
          const off = room.on(
            'peers',
            (list) => {
              if (list.some((p) => p.state === 'p2p')) { status.replaceChildren(t('connected')); }
            },
          );
          this.ui.dialog.addEventListener('close', off, { once: true });
          result.replaceChildren(
            h('p', {}, t('yourReply')),
            this.ui.kit.copyField(reply.code, 4),
            this.ui.kit.qr(reply.code),
            h('p', { class: 'sas-line' }, t('verify'), ' ',
              h('strong', { class: 'sas' }, reply.sas)),
            status,
          );
        } else if (code?.kind === 'answer') {
          for (const room of this.ui.model.rooms.values()) {
            try {
              await room.acceptAnswer(code);
              this.ui.dialog.close();
              this.ui.select(room);
              return;
            } catch { /* try the next room */ }
          }
          this.ui.notify(t('invalidCode'));
        } else {
          this.ui.notify(t('invalidCode'));
        }
      } catch (err) { this.ui.notify(err.message); }
    };
    const input = this.ui.kit.codeInput(t('joinPlaceholder'), handle);
    input.area.value = prefill;
    this.ui.kit.open(t('joinTitle'), h('p', {}, t('joinHelp')), input.node,
      h('button', { class: 'primary', onclick: input.submit }, t('joinRoom')), result);
    if (prefill) handle(prefill);
  }
}
