// All DOM for the app. State lives in AppModel/Room; this file only renders it
// and forwards user actions. Layout: room list (rail) | active room (stage) | dialogs.
import { fromB64u, toB64u } from '../util/bytes.js';
import { saveSettings } from '../config.js';
import { decodeCode } from '../net/handshake.js';
import { encodeQr, qrPath } from '../qr/qr.js';
import { authorIdOf, quoteOf } from '../chat/envelope.js';
import { fmtSize, h, qrSvg, safeFileName } from './dom.js';
import { t } from './i18n.js';
import { ImageCard } from './image-card.js';
import {
  MAX_AT_ONCE, clipboardFiles, dragHasFiles, droppedFiles, stageFiles,
} from './attach.js';
import { connLine } from './conn.js';
import { JoinRequest } from '../chat/join.js';
import { MAX_GREETING } from '../chat/lobby.js';
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
  #quote = null;        // envelope the composer is replying to
  #drawQuote = () => {};
  #input = null;        // the composer's textarea
  #staged = new Map();  // room id -> files waiting in the message box to be sent
  #chipUrls = new Map(); // staged File -> object URL of its little preview
  #drawStaged = () => {};
  #stopScan = null;
  #joins = new Set();     // join requests still waiting for an owner's answer
  #ownerEvents = new WeakSet(); // rooms whose owner events we already listen to

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
    this.model.on('rooms', () => { this.#renderRail(); this.#watchRooms(); });
    this.#watchRooms();
    document.addEventListener('paste', (e) => this.#onPaste(e));
    for (const type of ['dragover', 'drop']) { // a file dropped beside the chat must not open
      window.addEventListener(type, (e) => dragHasFiles(e) && e.preventDefault());
    }
    this.#renderRail();
    this.#renderStage();
    return this;
  }

  /** Owner events that matter wherever the user currently is. */
  #watchRooms() {
    for (const room of this.model.rooms.values()) {
      if (this.#ownerEvents.has(room)) continue;
      this.#ownerEvents.add(room);
      room.on('requests', () => {
        const last = room.joinRequests.at(-1);
        if (last) this.notify(t('joinRequestFrom', { name: last.name, greeting: last.greeting }));
      });
      room.on('removed', () => {
        this.notify(t('removedBanner'));
        if (room === this.#current) this.#renderStage();
      });
    }
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
    this.#quote = null;
    const room = this.#current;
    if (!room) {
      this.stage.replaceChildren(
        h('div', { class: 'empty' }, h('h2', {}, t('noRoomTitle')), h('p', {}, t('noRoomHelp'))),
      );
      return;
    }
    const peers = h('ul', { class: 'peers', title: t('connHint') });
    const conn = h('div', { class: 'conninfo', hidden: true, role: 'status' });
    const quoteBar = h('div', { class: 'quote-bar', hidden: true });
    const chips = h('div', { class: 'attachments', hidden: true });
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
    this.#input = input;
    /** Run `change`, and keep the newest messages in view if that is where we were. */
    const keepBottom = (change) => {
      const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
      change();
      if (stick) log.scrollTop = log.scrollHeight;
    };
    /** Grow the message box with its text; CSS caps it so the chat above stays visible. */
    const fit = () => keepBottom(() => {
      input.style.height = 'auto';
      input.style.height = `${input.scrollHeight + input.offsetHeight - input.clientHeight}px`;
    });
    input.addEventListener('input', fit);
    const picker = h(
      'input',
      {
        type: 'file',
        multiple: true,
        hidden: true,
        onchange: () => {
          this.#stage(room, [...picker.files]);
          picker.value = '';
        },
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
        ...room.log.timeline().slice(-300).map(
          (env) => this.#renderMessage(room, env, () => drawLog()),
        )
      );
      if (nearBottom) log.scrollTop = log.scrollHeight;
    };
    const drawBrokers = (s = room.settings.brokersEnabled
      ? { connected: 0, total: room.settings.brokers.length } : null) => {
      brokers.textContent = s ? t('brokers', { n: s.connected, m: s.total }) : '';
    };
    this.#drawStaged = () => keepBottom(() => {
      const files = this.#staged.get(room.id) ?? [];
      chips.hidden = !files.length;
      chips.replaceChildren(...files.map((file) => this.#chip(room, file)));
    });
    const drawQuote = () => keepBottom(() => {
      const q = this.#quote;
      quoteBar.hidden = !q;
      quoteBar.replaceChildren(...(q ? [
        h('span', { class: 'quote-text' }, h('b', {}, q.name), ' ', quoteOf(q).text),
        h('button', {
          class: 'ghost', title: t('quoteCancel'), 'aria-label': t('quoteCancel'),
          onclick: () => this.#setQuote(null),
        }, '×'),
      ] : []));
    });
    this.#drawQuote = drawQuote;
    const sendButton = h('button', { class: 'primary', onclick: () => send() }, t('send'));
    let sending = false;
    const send = async () => {
      const text = input.value;
      const files = [...(this.#staged.get(room.id) ?? [])];
      if ((!text.trim() && !files.length) || sending) return;
      sending = true;
      sendButton.disabled = true;
      input.value = '';
      fit();
      try {
        for (const file of files) { // nothing leaves the message box before this point
          await room.shareFile(file);
          this.#unstage(room, file);
        }
        if (text.trim()) await room.sendText(text, this.#quote);
        this.#setQuote(null);
        drawLog(true);
      } catch (err) {
        input.value = text;
        fit();
        this.notify(err.message);
      } finally {
        sending = false;
        sendButton.disabled = false;
      }
    };
    input.addEventListener('keydown', (e) => {
      // IME-safe
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        send();
      }
    });
    let depth = 0; // dragenter/dragleave also fire for every child element
    const stopDrop = () => { depth = 0; this.stage.classList.remove('dropping'); };
    stopDrop();
    this.stage.dataset.drop = t('dropHere');
    this.stage.ondragenter = (e) => {
      if (dragHasFiles(e)) { depth++; this.stage.classList.add('dropping'); }
    };
    this.stage.ondragleave = (e) => { if (dragHasFiles(e) && --depth <= 0) stopDrop(); };
    this.stage.ondragover = (e) => { if (dragHasFiles(e)) e.preventDefault(); };
    this.stage.ondrop = (e) => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      stopDrop();
      const { files, folders } = droppedFiles(e.dataTransfer);
      this.#stage(room, files, folders);
    };

    if (room.removed) {
      input.disabled = true;
      input.placeholder = t('removedBanner');
      sendButton.disabled = true;
    }
    const membersBtn = room.roster
      ? h('button', { onclick: () => this.#membersDialog(room) }) : null;
    const drawMembersBtn = () => {
      if (!membersBtn) return;
      const open = room.isOwner ? room.joinRequests.length : 0;
      membersBtn.textContent = open ? `${t('members')} (${open})` : t('members');
    };
    drawMembersBtn();
    this.#offStage.push(room.on('requests', drawMembersBtn), room.on('roster', drawMembersBtn));

    this.stage.replaceChildren(
      h('header', { class: 'stage-head' },
        h('button', { class: 'ghost back', onclick: () => this.select(null) }, t('rooms')),
        h('h2', {}, room.label || t('roomDefault')),
        brokers,
        membersBtn,
        h('button', { onclick: () => this.#inviteDialog(room) }, t('invite')),
        h('button', { class: 'ghost', onclick: () => this.#leave(room) }, t('leave'))),
      peers, conn, log, quoteBar, chips,
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
        sendButton));

    this.#offStage.push(
      room.on('message', () => drawLog()),
      room.on('peers', drawPeers),
      room.on('brokers', drawBrokers),
      this.#holdToReveal(room, peers, conn));
    drawPeers(); drawBrokers(); drawLog(true);
    this.#drawStaged();
  }

  /** Hold V (or press and hold the member strip) to see how everyone is connected. */
  #holdToReveal(room, strip, panel) {
    let timer = null;
    let press = null;
    const refresh = async () => {
      const rows = await room.connectionInfo();
      panel.replaceChildren(...rows.map((row) => h('div', {}, connLine(row, t))));
    };
    const reveal = (on) => {
      clearInterval(timer);
      panel.hidden = !on;
      if (on) { refresh(); timer = setInterval(refresh, 1000); }
    };
    const typing = (e) => /^(input|textarea|select)$/i.test(e.target.tagName)
      || e.target.isContentEditable;
    const down = (e) => {
      const plain = !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey;
      if (plain && e.key.toLowerCase() === 'v' && !typing(e)) reveal(true);
    };
    const up = (e) => { if (e.key.toLowerCase() === 'v') reveal(false); };
    const off = () => reveal(false);
    const start = () => { press = setTimeout(() => reveal(true), 450); };
    const stop = () => { clearTimeout(press); reveal(false); };
    document.addEventListener('keydown', down);
    document.addEventListener('keyup', up);
    window.addEventListener('blur', off);
    strip.addEventListener('pointerdown', start);
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
      strip.addEventListener(type, stop);
    }
    return () => {
      reveal(false);
      clearTimeout(press);
      document.removeEventListener('keydown', down);
      document.removeEventListener('keyup', up);
      window.removeEventListener('blur', off);
    };
  }

  #renderMessage(room, env, redraw) {
    if (env.kind === 'gone') return this.#renderGone(room, env);
    const own = authorIdOf(env) === room.identity.id;
    const parts = env.kind === 'file' ? [this.#renderFile(room, env, redraw)] : [
      env.kind === 'reply' ? this.#renderQuote(room, env.body.q) : null,
      h('p', { class: 'text' }, env.kind === 'reply' ? env.body.text : env.body),
    ];
    const acts = h('span', { class: 'acts' },
      h('button', { class: 'ghost', onclick: () => this.#setQuote(env) }, t('reply')),
      own || room.isOwner
        ? h('button', { class: 'ghost', onclick: () => this.#confirmDelete(room, env) },
          t('deleteMsg')) : null);
    return h('li', { class: `msg ${own ? 'own' : 'other'}`, 'data-id': env.id },
      h('div', { class: 'meta' },
        own ? t('you') : env.name, ' ', h('time', {}, clock(env.ms)), acts),
      ...parts);
  }

  /** What is left of a deleted message: who deleted it, in its old place. */
  #renderGone(room, item) {
    this.#cards.get(`${room.id}:${item.id}`)?.dispose();
    this.#cards.delete(`${room.id}:${item.id}`);
    const text = item.by === room.identity.id
      ? t('youDeleted') : t('deletedBy', { name: item.name });
    return h('li', { class: 'msg gone', 'data-id': item.id }, h('p', { class: 'text' }, text));
  }

  #renderQuote(room, q) {
    const gone = room.log.isGone(q.id);
    return h('blockquote', {
      class: gone ? 'quote gone' : 'quote',
      onclick: () => !gone && this.#jumpTo(q.id),
    }, h('b', {}, q.name), ' ', gone ? t('quoteDeleted') : q.text);
  }

  #jumpTo(id) {
    const el = this.stage.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1200);
  }

  #setQuote(env) {
    this.#quote = env;
    this.#drawQuote();
    if (env) this.#input?.focus();
  }

  #confirmDelete(room, env) {
    if (!confirm(t('deleteConfirm'))) return;
    room.deleteMessage(env.id).catch((err) => this.notify(err.message));
  }

  // ---- image cards ----------------------------------------------------------------------------

  #imageCard(room, env) {
    if (!env.body.img || room.settings.imagePreviews === 'off') return null;
    const key = `${room.id}:${env.id}`;
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

  /** Put files into the message box (picker, paste, drop). They are only sent, to everyone
   *  in the room, when the user presses Enter or Send. */
  #stage(room, files, folders = 0) {
    if (folders) this.notify(t('noFolders'));
    const { list, tooBig, tooMany } = stageFiles(
      this.#staged.get(room.id) ?? [], files, { maxBytes: room.settings.maxFileBytes },
    );
    if (tooBig.length) {
      const [file] = tooBig;
      this.notify(t('fileTooBig', { name: file.name, max: fmtSize(room.settings.maxFileBytes) }));
    } else if (tooMany) this.notify(t('tooManyFiles', { n: MAX_AT_ONCE }));
    this.#staged.set(room.id, list);
    if (room === this.#current) { this.#drawStaged(); this.#input?.focus(); }
  }

  #unstage(room, file) {
    this.#staged.set(room.id, (this.#staged.get(room.id) ?? []).filter((f) => f !== file));
    const url = this.#chipUrls.get(file);
    if (url) URL.revokeObjectURL(url);
    this.#chipUrls.delete(file);
    if (room === this.#current) this.#drawStaged();
  }

  #chip(room, file) {
    const small = file.type.startsWith('image/') && file.size <= 15 * 1024 * 1024;
    if (small && !this.#chipUrls.has(file)) this.#chipUrls.set(file, URL.createObjectURL(file));
    return h('div', { class: 'chip' },
      small ? h('img', { class: 'chip-img', alt: '', src: this.#chipUrls.get(file) })
        : h('span', { class: 'chip-blank' }),
      h('span', { class: 'chip-name', title: file.name }, file.name),
      h('span', { class: 'file-size' }, fmtSize(file.size)),
      h('button', {
        class: 'ghost', title: t('removeAttachment'), 'aria-label': t('removeAttachment'),
        onclick: () => this.#unstage(room, file),
      }, '×'));
  }

  /** Ctrl/Cmd+V: files on the clipboard are staged; text pastes as usual. */
  #onPaste(event) {
    const room = this.#current;
    const files = clipboardFiles(event.clipboardData);
    if (!room || !files.length || this.dialog.open) return;
    const field = event.target.closest?.('input, textarea');
    if (field && !field.closest('.composer')) return; // other fields keep their own paste
    event.preventDefault();
    this.#stage(room, files);
  }

  #leave(room) {
    if (!confirm(t('leaveConfirm'))) return;
    for (const [key, card] of this.#cards) {
      if (key.startsWith(`${room.id}:`)) { card.dispose(); this.#cards.delete(key); }
    }
    for (const file of this.#staged.get(room.id) ?? []) this.#unstage(room, file);
    this.#staged.delete(room.id);
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
    const link = h('div');
    const owned = !!room.roster;
    (owned ? room.joinLinkParts().then(
      ({ lobbySecret, ownerId }) => `${location.origin}${location.pathname}#j=${
        toB64u(lobbySecret)}.${ownerId}`,
    ) : Promise.resolve(roomLink(room))).then((url) => link.replaceChildren(this.#copyField(url)));
    const help = !owned ? 'linkHelp' : room.isOwner ? 'joinLinkHelpOwner' : 'joinLinkHelp';
    this.#open(t('invite'),
      h('section', {}, h('h3', {}, t(owned ? 'joinLinkTitle' : 'linkTitle')),
        h('p', {}, t(help)), link),
      !owned || room.isOwner
        ? h('section', {}, h('h3', {}, t('pairTitle')), h('p', {}, t('pairHelp')), pair)
        : null);
  }

  /** Members, and for the owner: join requests, removal and handing the room over. */
  #membersDialog(room) {
    const body = h('div', { class: 'members' });
    const run = (job) => job.catch((err) => this.notify(err.message));
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
          ...(asks.length ? asks : [h('p', { class: 'file-size' }, t('noRequests'))])] : []));
    };
    draw();
    const offs = ['roster', 'requests', 'peers'].map((name) => room.on(name, draw));
    this.dialog.addEventListener('close', () => offs.forEach((off) => off()), { once: true });
    this.#open(t('members'), body);
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
      if (!text) return this.notify(t('greetingNeeded'));
      send.disabled = true;
      greeting.disabled = true;
      const { settings, identity } = this.model;
      const ask = new JoinRequest({
        identity, lobbySecret, ownerId, greeting: text, settings,
        name: settings.name || `anon-${identity.id.slice(0, 4)}`,
      });
      this.#joins.add(ask); // keeps knocking even if this dialog is closed
      ask.on('status', (s) => {
        status.replaceChildren(t(texts[s]));
        if (s === 'declined' || s === 'timeout') this.notify(t(texts[s]));
        if (s !== 'connecting' && s !== 'waiting') this.#joins.delete(ask);
      });
      ask.on('approved', async (grant) => {
        try {
          const room = await this.model.completeJoin(grant);
          if (this.dialog.open) this.dialog.close();
          this.select(room);
        } catch (err) { this.notify(err.message); }
      });
      try { await ask.start(); } catch (err) { this.notify(err.message); }
      return undefined;
    };
    result.replaceChildren(h('p', {}, t('greetingHelp')), greeting, send, status);
  }

  #joinDialog(prefill = '') {
    const result = h('div', { class: 'pair' });
    const handle = async (text) => {
      const lobby = /#j=([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{11})/.exec(text);
      const link = /#r=([A-Za-z0-9_-]{22})/.exec(text);
      const code = decodeCode(text);
      try {
        if (lobby) {
          if (lobby[2] === this.model.identity.id) throw new Error(t('ownLink'));
          this.#greetingForm(result, fromB64u(lobby[1]), lobby[2]);
        } else if (link) {
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
