// All DOM for the app. State lives in AppModel/Room; this file only renders it
// and forwards user actions. Layout: room list (rail) | active room (stage) | dialogs.
import { fromB64u, toB64u } from '../util/bytes.js';
import { saveSettings } from '../config.js';
import { decodeCode } from '../net/handshake.js';
import { encodeQr, qrPath } from '../qr/qr.js';
import { authorIdOf } from '../chat/envelope.js';
import { fmtSize, h, qrSvg, safeFileName } from './dom.js';
import { t } from './i18n.js';
import { ImageCard } from './image-card.js';
import { canScan, scanQr } from './scanner.js';

export const mountUi = (root, model) => new Ui(root, model).start();

const roomLink = (room) => `${location.origin}${location.pathname}#r=${toB64u(room.secret)}`;
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

class Ui {
  #current = null;      // active Room
  #offStage = [];       // unsubscribers for the active room
  #watched = new Set(); // rooms whose 'peers' events refresh the rail
  #downloads = new Map(); // file id -> { status, pct, url, error }
  #cards = new Map();   // "<room id>:<file id>" -> ImageCard (keeps its DOM across redraws)
  #watching = new Map(); // element -> callback for when it scrolls into view
  #seen = null;         // IntersectionObserver
  #stopScan = null;

  constructor(root, model) {
    this.root = root;
    this.model = model;
  }

  start() {
    this.rail = h('aside', { class: 'rail' });
    this.stage = h('main', { class: 'stage' });
    this.toast = h('div', { class: 'toast', role: 'status' });
    this.dialog = h('dialog', { onclose: () => this.#stopScan?.() });
    this.shell = h('div', { class: 'shell', 'data-view': 'rooms' }, this.rail, this.stage);
    this.root.replaceChildren(this.shell, this.toast, this.dialog);
    this.model.on('rooms', () => this.#renderRail());
    this.#renderRail();
    this.#renderStage();
    return this;
  }

  select(room) {
    this.#current = room;
    this.shell.dataset.view = room ? 'chat' : 'rooms';
    this.#renderRail();
    this.#renderStage();
  }

  notify(text) {
    this.toast.textContent = text;
    this.toast.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.classList.remove('show'), 4500);
  }

  // ---- rail: room list ---------------------------------------------------------------

  #renderRail() {
    const rooms = [...this.model.rooms.values()];
    for (const room of rooms) {
      if (this.#watched.has(room)) continue;
      this.#watched.add(room);
      room.on('peers', () => this.#renderRail());
    }
    const items = rooms.map((room) => {
      const direct = room.peerList.filter((p) => p.state === 'p2p').length;
      return h('li', {},
        h('button', { class: 'room-item', 'aria-current': room === this.#current ? 'true'
          : null, onclick: () => this.select(room) },
          h('span', { class: 'room-name' }, room.label || t('roomDefault')),
          h(
            'span',
            { class: direct ? 'dot on' : 'dot', title: t('direct') },
            direct ? String(direct) : '',
          )));
    });
    this.rail.replaceChildren(
      h(
        'header',
        {},
        h('h1', {}, 'knot'),
        h('button', { class: 'ghost', onclick: () => this.#settingsDialog() }, t('settings')),
      ),
      h('ul', { class: 'rooms' }, items),
      h('footer', {},
        h('button', { class: 'primary', onclick: () => this.#createRoom() }, t('newRoom')),
        h('button', { onclick: () => this.#joinDialog() }, t('joinRoom'))),
    );
  }

  async #createRoom() {
    const room = await this.model.createRoom(`${t('roomDefault')} ${this.model.rooms.size + 1}`);
    this.select(room);
    this.#inviteDialog(room);
  }

  // ---- stage: active room ------------------------------------------------------------------

  #renderStage() {
    this.#offStage.splice(0).forEach((off) => off());
    this.#seen?.disconnect();
    this.#watching.clear();
    const room = this.#current;
    if (!room) {
      this.stage.replaceChildren(
        h('div', { class: 'empty' }, h('h2', {}, t('noRoomTitle')), h('p', {}, t('noRoomHelp'))),
      );
      return;
    }
    const peers = h('ul', { class: 'peers' });
    const brokers = h('span', { class: 'brokers' });
    const log = h('ol', { class: 'log', 'aria-live': 'polite' });
    const input = h(
      'textarea',
      {
        rows: 1,
        placeholder: t('typeMessage'),
        maxLength: room.settings.maxTextLength,
        'aria-label': t('typeMessage'),
      },
    );
    const picker = h(
      'input',
      {
        type: 'file',
        hidden: true,
        onchange: () => picker.files[0] && this.#share(room, picker.files[0]).finally(
          () => { picker.value = ''; },
        ),
      },
    );

    const drawPeers = () => {
      peers.replaceChildren(
        ...room.peerList.map(
          (p) => h(
            'li',
            { class: `peer ${p.state}`, title: p.sas ? `${t('verify')} ${p.sas}` : '' },
            `${p.name} · ${t(p.state === 'p2p' ? 'direct' : p.state)}`,
          ),
        )
      );
    };
    const drawLog = (stickToBottom = false) => {
      const nearBottom = stickToBottom || log.scrollHeight - log.scrollTop - log.clientHeight < 80;
      log.replaceChildren(
        ...room.log.list().slice(-300).map(
          (env) => this.#renderMessage(room, env, () => drawLog()),
        )
      );
      if (nearBottom) log.scrollTop = log.scrollHeight;
    };
    const drawBrokers = (s = room.settings.brokersEnabled
      ? { connected: 0, total: room.settings.brokers.length } : null) => {
      brokers.textContent = s ? t('brokers', { n: s.connected, m: s.total }) : '';
    };
    const send = async () => {
      const text = input.value;
      if (!text.trim()) return;
      input.value = '';
      try { await room.sendText(text); drawLog(true); } catch (err) {
        input.value = text;
        this.notify(err.message);
      }
    };
    input.addEventListener('keydown', (e) => {
      // IME-safe
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        send();
      }
    });
    this.stage.ondragover = (e) => e.preventDefault();
    this.stage.ondrop = (e) => {
      e.preventDefault();
      if (e.dataTransfer.files[0]) this.#share(room, e.dataTransfer.files[0]);
    };

    this.stage.replaceChildren(
      h('header', { class: 'stage-head' },
        h('button', { class: 'ghost back', onclick: () => this.select(null) }, t('rooms')),
        h('h2', {}, room.label || t('roomDefault')),
        brokers,
        h('button', { onclick: () => this.#inviteDialog(room) }, t('invite')),
        h('button', { class: 'ghost', onclick: () => this.#leave(room) }, t('leave'))),
      peers, log,
      h('div', { class: 'composer' }, input, picker,
        h(
          'button',
          {
            class: 'ghost',
            title: t('attach'),
            'aria-label': t('attach'),
            onclick: () => picker.click(),
          },
          '+',
        ),
        h('button', { class: 'primary', onclick: send }, t('send'))));

    this.#offStage.push(
      room.on('message', () => drawLog()),
      room.on('peers', drawPeers),
      room.on('brokers', drawBrokers));
    drawPeers(); drawBrokers(); drawLog(true);
  }

  #renderMessage(room, env, redraw) {
    const own = authorIdOf(env) === room.identity.id;
    const body = env.kind === 'file' ? this.#renderFile(room, env, redraw) : h(
      'p',
      { class: 'text' },
      env.body,
    );
    return h('li', { class: `msg ${own ? 'own' : 'other'}` },
      h(
        'div',
        { class: 'meta' },
        own ? t('you') : env.name,
        ' ',
        h('time', {}, clock(env.ms)),
      ), body);
  }

  // ---- image cards ----------------------------------------------------------------------------

  #imageCard(room, env) {
    if (!env.body.img || room.settings.imagePreviews === 'off') return null;
    const key = `${room.id}:${env.body.id}`;
    let card = this.#cards.get(key);
    if (!card) {
      const host = {
        notify: (text) => this.notify(text),
        open: (c) => this.#lightbox(c),
        watch: (el, fn) => this.#watch(el, fn),
      };
      card = ImageCard.create(room, env, host);
      if (!card) return null;
      this.#cards.set(key, card);
      this.#trimCards();
    }
    card.mount();
    return card;
  }

  /** Run `fn` once `el` is (nearly) on screen. */
  #watch(el, fn) {
    if (!globalThis.IntersectionObserver) return fn();
    this.#seen ??= new IntersectionObserver((entries) => {
      for (const entry of entries.filter((e) => e.isIntersecting)) {
        this.#seen.unobserve(entry.target);
        const run = this.#watching.get(entry.target);
        this.#watching.delete(entry.target);
        run?.();
      }
    }, { rootMargin: '200px' });
    this.#watching.set(el, fn);
    this.#seen.observe(el);
  }

  #trimCards(max = 200) {
    for (const [key, card] of this.#cards) {
      if (this.#cards.size <= max) return;
      if (!card.el.isConnected) { card.dispose(); this.#cards.delete(key); }
    }
  }

  #lightbox(card) {
    const img = h('img', { class: 'lightbox-img', alt: card.name, src: card.currentUrl() });
    img.addEventListener('error', () => { img.src = card.previewUrl ?? img.src; }, { once: true });
    const { node, off } = card.actions();
    const sync = card.on('change', () => {
      const url = card.currentUrl();
      if (img.src !== url) img.src = url;
    });
    this.dialog.addEventListener('close', () => { off(); sync(); }, { once: true });
    this.#open(card.name, img, h('div', { class: 'actions' }, node));
    this.dialog.classList.add('wide');
  }

  #renderFile(room, env, redraw) {
    const card = this.#imageCard(room, env);
    if (card) return card.el;
    const { name, size, id } = env.body;
    const st = this.#downloads.get(id) ?? { status: 'idle' };
    const action = st.status === 'done'
      ? h('a', { class: 'button', href: st.url, download: safeFileName(name) }, t('saveFile'))
      : h('button', {
        disabled: st.status === 'loading',
        onclick: async () => {
          this.#downloads.set(id, { status: 'loading', pct: 0 });
          redraw();
          try {
            const blob = await room.downloadFile(
              env,
              (got, total) => {
                this.#downloads.get(id).pct = Math.floor((got / total) * 100);
                this.#updateProgress(id);
              },
            );
            this.#downloads.set(id, { status: 'done', url: URL.createObjectURL(blob) });
          } catch (err) {
            this.#downloads.set(id, { status: 'idle' });
            this.notify(err.message);
          }
          redraw();
        },
      }, st.status === 'loading' ? t('receiving', { pct: st.pct }) : t('download'));
    action.dataset.fileId = id;
    return h(
      'div',
      { class: 'file' },
      h('span', { class: 'file-name' }, name),
      h('span', { class: 'file-size' }, fmtSize(size)),
      action,
    );
  }

  #updateProgress(id) {
    const btn = this.stage.querySelector(`[data-file-id="${CSS.escape(id)}"]`);
    if (btn) btn.textContent = t('receiving', { pct: this.#downloads.get(id).pct });
  }

  async #share(room, file) {
    try { await room.shareFile(file); } catch (err) { this.notify(err.message); }
  }

  #leave(room) {
    if (!confirm(t('leaveConfirm'))) return;
    for (const [key, card] of this.#cards) {
      if (key.startsWith(`${room.id}:`)) { card.dispose(); this.#cards.delete(key); }
    }
    this.model.removeRoom(room.id).then(() => this.select(null));
  }

  // ---- dialogs ---------------------------------------------------------------------------------

  #open(title, ...content) {
    this.dialog.classList.remove('wide');
    this.dialog.replaceChildren(
      h(
        'header',
        {},
        h('h2', {}, title),
        h('button', { class: 'ghost', onclick: () => this.dialog.close() }, t('close')),
      ),
      ...content);
    if (!this.dialog.open) this.dialog.showModal();
  }

  /** Read-only field with a Copy button. */
  #copyField(value, rows = 1) {
    const field = h(
      'textarea',
      { class: 'code', readOnly: true, rows, value, onfocus: () => field.select() },
    );
    const button = h('button', {
      onclick: async () => {
        try { await navigator.clipboard.writeText(value); } catch {
          field.select();
          document.execCommand('copy');
        }
        button.textContent = t('copied');
        setTimeout(() => { button.textContent = t('copy'); }, 1500);
      },
    }, t('copy'));
    return h('div', { class: 'copy-field' }, field, button);
  }

  #qr(text) {
    try {
      const qr = encodeQr(text, 'L');
      return qrSvg(qrPath(qr, 4), qr.size, t('scan'));
    } catch { return null; }
  }

  /** Textarea + optional camera scanner; onText receives pasted or scanned text. */
  #codeInput(placeholder, onText) {
    const area = h('textarea', { class: 'code', rows: 3, placeholder });
    const video = h('video', { class: 'scan', playsInline: true, muted: true, hidden: true });
    const scan = canScan() && h('button', {
      onclick: () => {
        video.hidden = false;
        this.#stopScan = scanQr(
          video,
          (text) => { video.hidden = true; if (text) { area.value = text; onText(text); } },
        );
      },
    }, t('scan'));
    const submit = () => area.value.trim() && onText(area.value);
    area.addEventListener('paste', () => setTimeout(submit, 0));
    return { area, submit, node: h('div', { class: 'code-input' }, area, video, scan) };
  }

  #inviteDialog(room) {
    const pair = h('div', { class: 'pair' });
    const make = h('button', {
      onclick: async () => {
        make.disabled = true;
        try {
          const { code } = await room.createInvite();
          const sas = h('p', { class: 'sas-line' });
          const reply = this.#codeInput(t('replyPlaceholder'), async (text) => {
            const answer = decodeCode(text);
            if (answer?.kind !== 'answer') return this.notify(t('invalidCode'));
            try { await room.acceptAnswer(answer); } catch (err) { this.notify(err.message); }
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
          this.dialog.addEventListener('close', off, { once: true });
          pair.replaceChildren(this.#copyField(code, 4), this.#qr(code), reply.node,
            h('button', { class: 'primary', onclick: reply.submit }, t('connect')), sas);
        } catch (err) { this.notify(err.message); make.disabled = false; }
      },
    }, t('createCode'));
    pair.append(make);
    this.#open(t('invite'),
      h(
        'section',
        {},
        h('h3', {}, t('linkTitle')),
        h('p', {}, t('linkHelp')),
        this.#copyField(roomLink(room)),
      ),
      h('section', {}, h('h3', {}, t('pairTitle')), h('p', {}, t('pairHelp')), pair));
  }

  #joinDialog(prefill = '') {
    const result = h('div', { class: 'pair' });
    const handle = async (text) => {
      const link = /#r=([A-Za-z0-9_-]{22})/.exec(text);
      const code = decodeCode(text);
      try {
        if (link) {
          const room = await this.model.addRoom(fromB64u(link[1]), t('roomDefault'));
          this.dialog.close(); this.select(room);
        } else if (code?.kind === 'offer') {
          const { room, reply } = await this.model.joinOffer(code);
          this.select(room);
          const status = h('p', { class: 'sas-line' }, t('waiting'));
          const off = room.on(
            'peers',
            (list) => {
              if (list.some((p) => p.state === 'p2p')) { status.replaceChildren(t('connected')); }
            },
          );
          this.dialog.addEventListener('close', off, { once: true });
          result.replaceChildren(
            h('p', {}, t('yourReply')),
            this.#copyField(reply.code, 4),
            this.#qr(reply.code),
            h('p', { class: 'sas-line' }, t('verify'), ' ',
              h('strong', { class: 'sas' }, reply.sas)),
            status,
          );
        } else if (code?.kind === 'answer') {
          for (const room of this.model.rooms.values()) {
            try {
              await room.acceptAnswer(code);
              this.dialog.close();
              this.select(room);
              return;
            } catch { /* try the next room */ }
          }
          this.notify(t('invalidCode'));
        } else {
          this.notify(t('invalidCode'));
        }
      } catch (err) { this.notify(err.message); }
    };
    const input = this.#codeInput(t('joinPlaceholder'), handle);
    input.area.value = prefill;
    this.#open(t('joinTitle'), h('p', {}, t('joinHelp')), input.node,
      h('button', { class: 'primary', onclick: input.submit }, t('joinRoom')), result);
    if (prefill) handle(prefill);
  }

  openJoin(prefill) { this.#joinDialog(prefill); }

  #settingsDialog() {
    const s = this.model.settings;
    const name = h('input', { type: 'text', value: s.name, maxLength: 32 });
    const stun = h('textarea', { class: 'code', rows: 4, value: s.stunServers.join('\n') });
    const turn = h('textarea', { class: 'code', rows: 3, value: JSON.stringify(s.turnServers) });
    const brokers = h('textarea', { class: 'code', rows: 3, value: s.brokers.join('\n') });
    const useBrokers = h('input', { type: 'checkbox', checked: s.brokersEnabled });
    const relay = h('input', { type: 'checkbox', checked: s.relayFallback });
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
        Object.assign(
          s,
          {
            name: name.value.trim(),
            stunServers: stunList,
            turnServers: turnList,
            brokers: brokerList,
            brokersEnabled: useBrokers.checked,
            relayFallback: relay.checked,
            imagePreviews: previews.value,
          },
        );
        await saveSettings(this.model.kv, s);
        this.notify(t('saved'));
        this.dialog.close();
      } catch (err) { this.notify(t('badSettings', { why: err.message })); }
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
    this.#open(
      t('settings'),
      field(t('name'), name),
      field(t('stun'), stun),
      field(t('turn'), turn),
      field(t('brokerList'), brokers),
      check(t('useBrokers'), useBrokers),
      check(t('relayText'), relay),
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
