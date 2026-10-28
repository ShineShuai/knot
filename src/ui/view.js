// All DOM for the app. State lives in AppModel/Room; this file only renders it
// and forwards user actions. Layout: room list (rail) | active room (stage) | dialogs.
import { fromB64u, toB64u } from '../util/bytes.js';
import { saveSettings } from '../config.js';
import { decodeCode } from '../net/handshake.js';
import { encodeQr, qrPath } from '../qr/qr.js';
import { ADMIN_KINDS, authorIdOf, quoteOf } from '../chat/envelope.js';
import { noticeLine } from '../chat/notice.js';
import { searchLog } from '../chat/search.js';
import { nextRoomName } from '../app.js';
import { fmtSize, h, qrSvg, safeFileName } from './dom.js';
import { LANGUAGES, setLanguage, t } from './i18n.js';
import { VERSION } from '../version.js';
import { ImageCard } from './image-card.js';
import {
  MAX_AT_ONCE, clipboardFiles, dragHasFiles, droppedFiles, stageFiles,
} from './attach.js';
import { connLine } from './conn.js';
import { JoinRequest } from '../chat/join.js';
import { MAX_GREETING } from '../chat/lobby.js';
import { canScan, scanQr } from './scanner.js';
import { CallPanel } from './call-view.js';
import { exportJson, exportText } from './export.js';
import { Notifier } from './notifier.js';

const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

/** `opts`: `updates` (an UpdateWatcher), `notifierEnv` (tests): optional. */
export const mountUi = (root, model, opts) => new Ui(root, model, opts).start();

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
  #editing = null;      // our own envelope the message box is changing (instead of a new message)
  #fitInput = () => {}; // resize the message box to its text
  #reactTo = null;      // id of the message whose emoji palette is open
  #updateReady = false; // a newer version of the app has been published
  #input = null;        // the composer's textarea
  #staged = new Map();  // room id -> files waiting in the message box to be sent
  #chipUrls = new Map(); // staged File -> object URL of its little preview
  #drawStaged = () => {};
  #stopScan = null;
  #joins = new Set();     // join requests still waiting for an owner's answer
  #ownerEvents = new WeakSet(); // rooms whose owner events we already listen to
  #codes = new Set();     // rooms for which a recovery code is being made right now

  constructor(root, model, opts = {}) {
    this.root = root;
    this.model = model;
    this.opts = opts;
    this.notifier = new Notifier({
      settings: model.settings, env: opts.notifierEnv,
      isActive: (room) => room === this.#current && this.#viewing(),
      open: (id) => this.#openRoom(id),
    });
  }

  start() {
    this.rail = h('aside', { class: 'rail' });
    this.stage = h('main', { class: 'stage' });
    this.toast = h('div', { class: 'toast', role: 'status' });
    this.dialog = h('dialog', { onclose: () => this.#stopScan?.() });
    this.shell = h('div', { class: 'shell', 'data-view': 'rooms' }, this.rail, this.stage);
    this.callPanel = new CallPanel({ notify: (text) => this.notify(text) });
    this.updateBar = h('div', { class: 'update-bar', role: 'status', hidden: true });
    this.root.replaceChildren(
      this.updateBar, this.shell, this.callPanel.element, this.toast, this.dialog,
    );
    this.opts.updates?.on('update', () => { this.#updateReady = true; this.#drawUpdateBar(); });
    globalThis.navigator?.serviceWorker?.addEventListener?.( // a clicked notification
      'message', (e) => e.data?.knot === 'open-room' && this.#openRoom(e.data.room),
    );
    document.addEventListener('visibilitychange', () => this.#markViewed());
    window.addEventListener('focus', () => this.#markViewed());
    this.model.on('rooms', () => { this.#renderRail(); this.#watchRooms(); });
    this.#watchRooms();
    document.addEventListener('paste', (e) => this.#onPaste(e));
    for (const type of ['dragover', 'drop']) { // a file dropped beside the chat must not open
      window.addEventListener(type, (e) => dragHasFiles(e) && e.preventDefault());
    }
    this.#renderRail();
    this.#renderStage();
    this.#drawUpdateBar();
    return this;
  }

  // ---- unread, updates ------------------------------------------------------------------

  /** On screen right now: the page is visible and has the focus. */
  #viewing() { return document.hidden !== true && (document.hasFocus?.() ?? true); }

  /** The room in view counts as read. */
  #markViewed() {
    if (this.#current && this.#viewing()) this.#current.markRead();
  }

  #openRoom(id) {
    const room = this.model.rooms.get(id);
    if (!room) return;
    window.focus?.();
    this.select(room);
  }

  /** Unread counts: in the room list, in the tab title and on the installed app's icon. */
  #refreshUnread() {
    const total = [...this.model.rooms.values()].reduce((sum, room) => sum + room.unread, 0);
    document.title = total ? `(${total}) knot` : 'knot';
    const badge = total ? navigator.setAppBadge?.(total) : navigator.clearAppBadge?.();
    badge?.catch?.(() => {}); // not every installed app may show a badge
    this.#renderRail();
  }

  #drawUpdateBar() {
    this.updateBar.hidden = !this.#updateReady;
    this.updateBar.replaceChildren(
      h('span', {}, t('updateAvailable')),
      h('button', { class: 'primary', onclick: () => this.#reload() }, t('updateReload')),
      h('button', {
        class: 'ghost', title: t('close'), 'aria-label': t('close'),
        onclick: () => { this.updateBar.hidden = true; },
      }, '×'),
    );
  }

  #reload() {
    const calling = [...this.model.rooms.values()].some((room) => room.call.joined);
    if (calling && !confirm(t('updateEndsCall'))) return;
    location.reload();
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
      room.on('roster', () => { if (room.isOwner) this.#ensureRecovery(room); });
      room.call.on('change', () => this.callPanel.sync(room));
      room.on('unread', () => this.#refreshUnread());
      this.notifier.watch(room);
      room.on('removed', () => {
        this.notify(t('removedBanner'));
        if (room === this.#current) this.#renderStage();
      });
    }
  }

  select(room) {
    this.#current = room;
    this.shell.dataset.view = room ? 'chat' : 'rooms';
    this.#renderStage();
    this.#markViewed();
    this.#refreshUnread();
  }

  /** The language changed: redraw everything on screen in the new one. */
  relocalize() {
    for (const card of this.#cards.values()) card.dispose(); // their labels are baked in
    this.#cards.clear();
    this.#renderRail();
    this.#renderStage();
    this.callPanel.relabel();
    this.#drawUpdateBar();
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
      const unread = room.unread;
      return h('li', {},
        h('button', { class: 'room-item', 'aria-current': room === this.#current ? 'true'
          : null, onclick: () => this.select(room) },
          h('span', { class: unread ? 'room-name new' : 'room-name' },
            room.label || t('roomDefault')),
          unread ? h('span', {
            class: 'unread', title: t('unread', { n: unread }),
            'aria-label': t('unread', { n: unread }),
          }, unread > 99 ? '99+' : String(unread)) : null,
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
        h('h1', {}, 'knot', h('small', { class: 'version' }, `v${VERSION}`)),
        h('button', { class: 'ghost', onclick: () => this.#settingsDialog() }, t('settings')),
      ),
      h('ul', { class: 'rooms' }, items),
      h('footer', {},
        h('button', { class: 'primary', onclick: () => this.#newRoomDialog() }, t('newRoom')),
        h('button', { onclick: () => this.#joinDialog() }, t('joinRoom'))),
    );
  }

  /** Nothing is created until the button is pressed: Cancel or Close leave things as they were. */
  #newRoomDialog() {
    this.#nameDialog({
      title: t('newRoom'), button: t('createRoom'), value: this.#freeRoomName(),
      onSave: (name) => this.#createRoom(name),
    });
  }

  #freeRoomName() {
    return nextRoomName([...this.model.rooms.values()].map((r) => r.label), t('roomDefault'));
  }

  #renameDialog(room) {
    this.#nameDialog({
      title: t('renameRoom'), button: t('save'), value: room.label || this.#freeRoomName(),
      onSave: async (name) => {
        await this.model.renameRoom(room.id, name);
        this.dialog.close();
        if (room === this.#current) this.#renderStage();
      },
    });
  }

  /** A one-field dialog: a name, then the action button. Enter works like the button. */
  #nameDialog({ title, value, button, onSave }) {
    const input = h('input', { type: 'text', maxLength: 40, value });
    const save = h('button', { class: 'primary' }, button);
    const go = async () => {
      if (save.disabled) return; // a double click must not do it twice
      save.disabled = true;
      try { await onSave(input.value); } catch (err) {
        this.notify(err.message);
        save.disabled = false;
      }
    };
    save.onclick = go;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) go(); });
    this.#open(title,
      h('label', { class: 'field' }, t('roomName'), input),
      h('div', { class: 'actions' }, save,
        h('button', { onclick: () => this.dialog.close() }, t('cancel'))));
    input.focus?.();
    input.select?.();
  }

  async #createRoom(name) {
    const label = name.trim().slice(0, 40) || this.#freeRoomName();
    const room = await this.model.createRoom(label);
    this.select(room);
    await this.#ensureRecovery(room, () => this.#inviteDialog(room));
  }

  /** The owner needs a recovery code: make one and show it once. `force`: replace the old. */
  async #ensureRecovery(room, after = null, force = false) {
    const needed = room.isOwner && (force || !room.roster.recoveryKey) && !this.#codes.has(room);
    if (!needed) { after?.(); return; }
    this.#codes.add(room);
    try {
      this.#recoveryDialog(await room.newRecoveryCode(), after);
    } catch (err) {
      this.notify(err.message);
      after?.();
    } finally { this.#codes.delete(room); }
  }

  #recoveryDialog(code, after) {
    this.#open(t('recoveryTitle'),
      h('p', {}, t('recoveryHelp')),
      this.#copyField(code),
      h('div', { class: 'actions' },
        h('button', { class: 'primary', onclick: () => this.dialog.close() }, t('recoverySaved'))));
    if (after) this.dialog.addEventListener('close', after, { once: true });
  }

  // ---- stage: active room ------------------------------------------------------------------

  #renderStage() {
    this.#offStage.splice(0).forEach((off) => off());
    this.#seen?.disconnect();
    this.#watching.clear();
    this.#quote = null;
    this.#editing = null;
    this.#reactTo = null;
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
    const searchInput = h('input', {
      type: 'text', placeholder: t('search'), 'aria-label': t('search'),
    });
    const searchCount = h('span', { class: 'search-count' });
    const searchBar = h('div', { class: 'searchbar', hidden: true },
      searchInput, searchCount,
      h('button', {
        class: 'ghost', title: t('searchClose'), 'aria-label': t('searchClose'),
        onclick: () => closeSearch(),
      }, '×'));
    let query = '';   // what the search box holds: while it is not empty, only hits are shown
    let shown = 300;  // how many of the newest messages the log shows
    const callButtons = h('span', { class: 'call-buttons' });
    const callBanner = h('div', { class: 'call-banner', hidden: true, role: 'status' });
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
      const hits = query ? searchLog(room, query) : null;
      searchCount.textContent = hits ? t(hits.length ? 'searchCount' : 'searchNone',
        { n: hits.length }) : '';
      const opts = hits ? { onShow: (env) => showInChat(env) } : {};
      log.replaceChildren(
        ...(hits ?? room.log.timeline().slice(-shown)).map(
          (env) => this.#renderMessage(room, env, () => drawLog(), opts),
        )
      );
      if (nearBottom) log.scrollTop = log.scrollHeight;
    };
    const closeSearch = () => {
      query = '';
      searchInput.value = '';
      searchBar.hidden = true;
      drawLog(true);
    };
    const toggleSearch = () => {
      if (!searchBar.hidden) return closeSearch();
      searchBar.hidden = false;
      return searchInput.focus();
    };
    /** Leave the search and scroll to the message in the conversation. */
    const showInChat = (env) => {
      shown = Infinity;
      closeSearch();
      this.#jumpTo(env.id);
    };
    searchInput.addEventListener('input', () => {
      query = searchInput.value.trim();
      drawLog(true);
    });
    searchInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSearch(); });
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
      const editing = this.#editing;
      const q = editing ?? this.#quote;
      quoteBar.hidden = !q;
      const cancel = t(editing ? 'editCancel' : 'quoteCancel');
      quoteBar.replaceChildren(...(q ? [
        h('span', { class: 'quote-text' }, h('b', {}, editing ? t('editing') : q.name), ' ',
          quoteOf(q, q.kind === 'file' ? null : room.log.textOf(q)).text),
        h('button', {
          class: 'ghost', title: cancel, 'aria-label': cancel,
          onclick: () => (editing ? this.#cancelEdit() : this.#setQuote(null)),
        }, '×'),
      ] : []));
    });
    this.#drawQuote = drawQuote;
    this.#fitInput = fit;
    const drawCall = () => {
      const { call } = room;
      const canStart = call.supported && !call.joined && !room.removed;
      callButtons.replaceChildren(...(canStart ? [
        this.#iconButton('📞', t('callAudio'), () => this.#startCall(room, false)),
        this.#iconButton('🎥', t('callVideo'), () => this.#startCall(room, true)),
      ] : []));
      const others = call.joined ? [] : [...call.members.keys()].map((id) => room.nameOf(id));
      callBanner.hidden = !others.length;
      callBanner.replaceChildren(...(others.length ? [
        h('span', { class: 'call-names' }, t('callInCall', { names: others.join(', ') })),
        canStart ? h('button', {
          class: 'primary', onclick: () => this.#startCall(room, false),
        }, t('callJoin')) : null,
      ] : []));
    };
    this.#offStage.push(room.call.on('change', drawCall));
    const sendButton = h('button', { class: 'primary', onclick: () => send() }, t('send'));
    let sending = false;
    const send = async () => {
      const text = input.value;
      const files = [...(this.#staged.get(room.id) ?? [])];
      const editing = this.#editing;
      if ((!text.trim() && !(files.length && !editing)) || sending) return;
      sending = true;
      sendButton.disabled = true;
      input.value = '';
      fit();
      try {
        if (editing) { // the staged files wait: an edit changes one message, nothing else
          await room.editMessage(editing.id, text);
          this.#editing = null;
          drawQuote();
        } else {
          for (const file of files) { // nothing leaves the message box before this point
            await room.shareFile(file);
            this.#unstage(room, file);
          }
          if (text.trim()) await room.sendText(text, this.#quote);
          this.#setQuote(null);
        }
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
      } else if (e.key === 'Escape' && this.#editing) this.#cancelEdit();
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
        h('button', {
          class: 'ghost', title: t('renameRoom'), 'aria-label': t('renameRoom'),
          onclick: () => this.#renameDialog(room),
        }, '✎'),
        this.#iconButton('🔍', t('search'), toggleSearch),
        this.#iconButton('⤓', t('exportHistory'), () => this.#exportDialog(room)),
        brokers,
        callButtons,
        membersBtn,
        h('button', { onclick: () => this.#inviteDialog(room) }, t('invite')),
        h('button', { class: 'ghost', onclick: () => this.#leave(room) }, t('leave'))),
      callBanner, searchBar, peers, conn, log, quoteBar, chips,
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
      room.on('message', () => { drawLog(); this.#markViewed(); }),
      room.on('peers', drawPeers),
      room.on('brokers', drawBrokers),
      this.#holdToReveal(room, peers, conn));
    drawPeers(); drawBrokers(); drawLog(true); drawCall();
    this.#drawStaged();
  }

  #iconButton(glyph, label, onclick) {
    return h('button', { class: 'ghost icon', title: label, 'aria-label': label, onclick }, glyph);
  }

  /** One call at a time: starting one here ends the call in any other room. */
  async #startCall(room, video) {
    try {
      for (const other of this.model.rooms.values()) if (other !== room) other.call.leave();
      const got = await room.call.join({ video });
      if (!got.audio) this.notify(t('callNoMic'));
      else if (video && !got.video) this.notify(t('callNoCam'));
    } catch (err) { this.notify(err.message); }
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

  /** `opts.onShow`: this is a search hit; its only action is to show it in the conversation. */
  #renderMessage(room, env, redraw, opts = {}) {
    if (env.kind === 'gone') return this.#renderGone(room, env);
    if (ADMIN_KINDS.includes(env.kind)) return this.#renderNotice(room, env);
    const own = authorIdOf(env) === room.identity.id;
    const edited = room.log.isEdited(env);
    const parts = env.kind === 'file' ? [this.#renderFile(room, env, redraw)] : [
      env.kind === 'reply' ? this.#renderQuote(room, env.body.q) : null,
      h('p', { class: 'text' }, room.log.textOf(env),
        edited ? h('span', { class: 'edited' }, ` (${t('edited')})`) : null),
    ];
    const button = (label, onclick) => h('button', { class: 'ghost', onclick }, label);
    const acts = h('span', { class: 'acts' }, ...(opts.onShow
      ? [button(t('searchShow'), () => opts.onShow(env))] : [
        button(t('reply'), () => this.#setQuote(env)),
        button(t('react'), () => {
          this.#reactTo = this.#reactTo === env.id ? null : env.id;
          redraw();
        }),
        own && env.kind !== 'file' ? button(t('edit'), () => this.#startEdit(room, env)) : null,
        own || room.isOwner ? button(t('deleteMsg'), () => this.#confirmDelete(room, env)) : null,
      ]));
    return h('li', { class: `msg ${own ? 'own' : 'other'}`, 'data-id': env.id },
      h('div', { class: 'meta' },
        own ? t('you') : env.name, ' ', h('time', {}, clock(env.ms)), acts),
      ...parts,
      opts.onShow ? null : this.#renderReactions(room, env, redraw));
  }

  /** The emoji under a message (tap one to add or take back yours) and, if open, the palette. */
  #renderReactions(room, env, redraw) {
    const byEmoji = room.log.overlay().reactions.get(env.id);
    const open = this.#reactTo === env.id;
    if (!byEmoji && !open) return null;
    const me = room.identity.id;
    const toggle = (emoji) => {
      this.#reactTo = null;
      redraw();
      room.react(env.id, emoji).catch((err) => this.notify(err.message));
    };
    const chips = [...(byEmoji ?? [])].map(([emoji, ids]) => h('button', {
      class: ids.includes(me) ? 'rx mine' : 'rx', 'aria-pressed': String(ids.includes(me)),
      title: ids.map((id) => (id === me ? t('you') : room.nameOf(id))).join(', '),
      onclick: () => toggle(emoji),
    }, `${emoji} ${ids.length}`));
    const pick = (emoji) => h(
      'button', { class: 'rx pick', title: emoji, onclick: () => toggle(emoji) }, emoji,
    );
    const palette = open ? h('span', { class: 'palette' }, ...REACTIONS.map(pick)) : null;
    return h('div', { class: 'reactions' }, ...chips, palette);
  }

  /** Membership changes, as one quiet line in the conversation. */
  #renderNotice(room, env) {
    return h('li', { class: 'msg gone', 'data-id': env.id },
      h('p', { class: 'text' }, noticeLine(room, env, t)));
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
    if (env && this.#editing) this.#cancelEdit();
    this.#quote = env;
    this.#drawQuote();
    if (env) this.#input?.focus();
  }

  /** Put one of our messages into the message box; sending then replaces its text. */
  #startEdit(room, env) {
    this.#quote = null;
    this.#editing = env;
    this.#input.value = room.log.textOf(env);
    this.#fitInput();
    this.#drawQuote();
    this.#input.focus();
  }

  #cancelEdit() {
    this.#editing = null;
    this.#input.value = '';
    this.#fitInput();
    this.#drawQuote();
  }

  // ---- export ---------------------------------------------------------------------------------

  #exportDialog(room) {
    const save = (extension, content, type) => () => (
      this.#download(room, extension, content(room), type)
    );
    this.#open(t('exportHistory'),
      h('p', {}, t('exportHelp', { n: room.log.size })),
      h('div', { class: 'actions' },
        h('button', { class: 'primary', onclick: save('txt', exportText, 'text/plain') },
          t('exportText')),
        h('button', { onclick: save('json', exportJson, 'application/json') }, t('exportJson'))));
  }

  #download(room, extension, content, type) {
    const day = new Date().toISOString().slice(0, 10);
    const name = safeFileName(`knot-${room.label || t('roomDefault')}-${day}.${extension}`);
    const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
    h('a', { href: url, download: name }).click();
    const timer = setTimeout(() => URL.revokeObjectURL(url), 10_000);
    timer.unref?.();
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
          ...(asks.length ? asks : [h('p', { class: 'file-size' }, t('noRequests'))]),
          h('h3', {}, t('recoveryTitle')),
          h('p', { class: 'file-size' },
            room.roster.recoveryKey ? t('recoverySet') : t('recoveryNotSet')),
          h('button', { onclick: () => this.#ensureRecovery(room, null, true) },
            t('newRecoveryCode'))] : []));
    };
    draw();
    const offs = ['roster', 'requests', 'peers'].map((name) => room.on(name, draw));
    this.dialog.addEventListener('close', () => offs.forEach((off) => off()), { once: true });
    this.#open(t('members'), body);
  }

  /** A recovery code was pasted: reopen the room and claim it once a member is online. */
  async #recoverForm(result, text) {
    const status = h('p', { class: 'sas-line' }, t('recoverWaiting'));
    result.replaceChildren(status);
    try {
      const room = await this.model.recoverRoom(text, t('roomDefault'));
      this.select(room);
      const timer = setTimeout(() => {
        if (room.isOwner) return;
        status.replaceChildren(t('recoverFailed'));
        this.notify(t('recoverFailed'));
      }, 90000);
      timer.unref?.();
      const off = room.on('roster', () => {
        if (!room.isOwner) return;
        off();
        clearTimeout(timer);
        this.notify(t('recoverDone'));
        if (this.dialog.open) this.dialog.close();
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
      if (!text) return this.notify(t('greetingNeeded'));
      send.disabled = true;
      greeting.disabled = true;
      const { settings, identity, WS } = this.model;
      const ask = new JoinRequest({
        identity, lobbySecret, ownerId, greeting: text, settings, WS,
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
      const code = text.includes('knot-rk1-') ? null : decodeCode(text);
      try {
        if (text.includes('knot-rk1-')) {
          this.#recoverForm(result, text);
        } else if (lobby) {
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
    const languages = { auto: t('languageAuto'), ...LANGUAGES };
    const language = h('select', {}, ...Object.entries(languages).map(
      ([value, label]) => h('option', { value, selected: value === s.language }, label),
    ));
    const stun = h('textarea', { class: 'code', rows: 4, value: s.stunServers.join('\n') });
    const turn = h('textarea', { class: 'code', rows: 3, value: JSON.stringify(s.turnServers) });
    const brokers = h('textarea', { class: 'code', rows: 3, value: s.brokers.join('\n') });
    const useBrokers = h('input', { type: 'checkbox', checked: s.brokersEnabled });
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
        const allowed = !notifications.checked || await this.notifier.enable();
        Object.assign(
          s,
          {
            name: name.value.trim(),
            language: language.value,
            stunServers: stunList,
            turnServers: turnList,
            brokers: brokerList,
            brokersEnabled: useBrokers.checked,
            relayFallback: relay.checked,
            notifications: notifications.checked && allowed,
            imagePreviews: previews.value,
          },
        );
        await saveSettings(this.model.kv, s);
        if (languageChanged) { setLanguage(s.language); this.relocalize(); }
        this.notify(t(allowed ? 'saved' : 'notifyBlocked'));
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
      field(t('language'), language),
      field(t('name'), name),
      field(t('stun'), stun),
      field(t('turn'), turn),
      field(t('brokerList'), brokers),
      check(t('useBrokers'), useBrokers),
      check(t('relayText'), relay),
      this.notifier.supported ? check(t('notifications'), notifications) : null,
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
