// All DOM for the app. State lives in AppModel/Room; this file only renders it
// and forwards user actions. Layout: room list (rail) | active room (stage) | dialogs.
// The page keeps the room list, the stage and the unread bookkeeping; the rest has its own
// module: the message box (composer.js), messages (messages.js), image cards
// (image-cards.js) and the dialogs (dialog-kit.js, room-dialogs.js, join-dialogs.js,
// settings-dialogs.js).
import { searchLog } from '../chat/search.js';
import { h } from './dom.js';
import { peerLabel, withDevice } from './alias.js';
import { t } from './i18n.js';
import { VERSION } from '../version.js';
import { dragHasFiles } from './attach.js';
import { CallPanel } from './call-view.js';
import { Composer } from './composer.js';
import { DialogKit } from './dialog-kit.js';
import { ImageCards } from './image-cards.js';
import { JoinDialogs } from './join-dialogs.js';
import { Messages } from './messages.js';
import { Notifier } from './notifier.js';
import { holdToReveal } from './reveal.js';
import { RoomDialogs } from './room-dialogs.js';
import { SettingsDialogs } from './settings-dialogs.js';

/** `opts`: `updates` (an UpdateWatcher), `notifierEnv` (tests): optional. */
export const mountUi = (root, model, opts) => new Ui(root, model, opts).start();

class Ui {
  #current = null;      // active Room
  #offStage = [];       // unsubscribers for the active room
  #watched = new Set(); // rooms whose 'peers' events refresh the rail
  #updateReady = false; // a newer version of the app has been published
  #unlinkedShown = false;
  #ownerEvents = new WeakSet(); // rooms whose owner events we already listen to

  constructor(root, model, opts = {}) {
    this.root = root;
    this.model = model;
    this.opts = opts;
    this.composer = new Composer(this);
    this.messages = new Messages(this);
    this.images = new ImageCards(this);
    this.roomDialogs = new RoomDialogs(this);
    this.joinDialogs = new JoinDialogs(this);
    this.settingsDialogs = new SettingsDialogs(this);
    this.notifier = new Notifier({
      settings: model.settings, env: opts.notifierEnv,
      isActive: (room) => room === this.#current && this.#viewing(),
      open: (id) => this.#openRoom(id),
    });
  }

  /** The room on the stage (null: the room list is showing). */
  get current() { return this.#current; }

  start() {
    this.rail = h('aside', { class: 'rail' });
    this.stage = h('main', { class: 'stage' });
    this.toast = h('div', { class: 'toast', role: 'status' });
    this.dialog = h('dialog');
    this.kit = new DialogKit(this.dialog);
    this.shell = h('div', { class: 'shell', 'data-view': 'rooms' }, this.rail, this.stage);
    this.callPanel = new CallPanel({
      notify: (text) => this.notify(text),
      openChat: (room) => (room === this.#current ? this.#markViewed() : this.select(room)),
      onMode: (mode) => { this.shell.dataset.call = mode; this.#markViewed(); },
      speaking: this.opts.speaking,
    });
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
    document.addEventListener('paste', (e) => this.composer.onPaste(e));
    for (const type of ['dragover', 'drop']) { // a file dropped beside the chat must not open
      window.addEventListener(type, (e) => dragHasFiles(e) && e.preventDefault());
    }
    this.#renderRail();
    this.renderStage();
    this.#drawUpdateBar();
    return this;
  }

  // ---- unread, updates ------------------------------------------------------------------

  /** On screen right now: the page is visible and has the focus, and a full-screen call is
   *  not covering the conversation. */
  #viewing() {
    return document.hidden !== true && (document.hasFocus?.() ?? true)
      && !this.callPanel.covers(this.#current);
  }

  /** The room in view counts as read. */
  #markViewed() {
    if (this.#current && this.#viewing()) this.#current.markRead();
  }

  /** The main device withdrew this device. */
  async #onUnlinked() {
    if (!this.model.isLinked || this.#unlinkedShown) return;
    this.#unlinkedShown = true;
    await this.model.forgetLinking();
    this.notify(t('unlinkedNotice'));
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
      room.on('roster', () => { if (room.isOwner) this.roomDialogs.ensureRecovery(room); });
      room.call.on('change', () => this.callPanel.sync(room));
      room.on('unread', () => this.#refreshUnread());
      room.on('unlinked', () => this.#onUnlinked());
      this.notifier.watch(room);
      room.on('removed', () => {
        this.notify(t('removedBanner'));
        if (room === this.#current) this.renderStage();
      });
    }
  }

  select(room) {
    this.#current = room;
    this.shell.dataset.view = room ? 'chat' : 'rooms';
    this.renderStage();
    this.#markViewed();
    this.#refreshUnread();
  }

  /** The language changed: redraw everything on screen in the new one. */
  relocalize() {
    this.images.disposeAll(); // their labels are baked in
    this.#renderRail();
    this.renderStage();
    this.callPanel.relabel();
    this.#drawUpdateBar();
  }

  notify(text) {
    this.toast.textContent = text;
    this.toast.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.classList.remove('show'), 4500);
  }

  /** A link or code from the address bar: open the Join dialog with it. */
  openJoin(prefill) { this.joinDialogs.open(prefill); }

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
        h('button', { class: 'ghost', onclick: () => this.settingsDialogs.open() }, t('settings')),
      ),
      h('ul', { class: 'rooms' }, items),
      h('footer', {},
        h('button', { class: 'primary', onclick: () => this.roomDialogs.newRoom() }, t('newRoom')),
        h('button', { onclick: () => this.joinDialogs.open() }, t('joinRoom'))),
    );
  }








  // ---- stage: active room ------------------------------------------------------------------


  // ---- stage: active room ------------------------------------------------------------------

  renderStage() {
    this.#offStage.splice(0).forEach((off) => off());
    this.images.reset();
    this.composer.reset();
    this.messages.reset();
    const room = this.#current;
    if (!room) {
      this.stage.replaceChildren(
        h('div', { class: 'empty' }, h('h2', {}, t('noRoomTitle')), h('p', {}, t('noRoomHelp'))),
      );
      return;
    }
    const peers = h('ul', { class: 'peers', title: t('connHint') });
    const conn = h('div', { class: 'conninfo', hidden: true, role: 'status' });
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
    /** Run `change`, and keep the newest messages in view if that is where we were. */
    const keepBottom = (change) => {
      const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
      change();
      if (stick) log.scrollTop = log.scrollHeight;
    };

    const drawPeers = () => {
      peers.replaceChildren(
        ...room.peerList.map(
          (p) => h(
            'li',
            { class: `peer ${p.state}`, title: p.sas ? `${t('verify')} ${p.sas}` : '' },
            `${withDevice(p.name, p.device)} · ${t(p.state === 'p2p' ? 'direct' : p.state)}`,
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
          (env) => this.messages.render(room, env, () => drawLog(), opts),
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
      this.messages.jumpTo(env.id);
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
    const drawCall = () => {
      const { call } = room;
      const canStart = call.supported && !call.joined && !room.removed;
      callButtons.replaceChildren(...(canStart ? [
        this.#iconButton('📞', t('callAudio'), () => this.#startCall(room, false)),
        this.#iconButton('🎥', t('callVideo'), () => this.#startCall(room, true)),
      ] : []));
      const others = call.joined ? [] : [...call.members.keys()].map((id) => peerLabel(room, id));
      callBanner.hidden = !others.length;
      callBanner.replaceChildren(...(others.length ? [
        h('span', { class: 'call-names' }, t('callInCall', { names: others.join(', ') })),
        canStart ? h('button', {
          class: 'primary', onclick: () => this.#startCall(room, false),
        }, t('callJoin')) : null,
      ] : []));
    };
    this.#offStage.push(room.call.on('change', drawCall));
    const composer = this.composer.mount(room, { keepBottom, drawLog });

    const membersBtn = room.roster
      ? h('button', { onclick: () => this.roomDialogs.members(room) }) : null;
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
          onclick: () => this.roomDialogs.rename(room),
        }, '✎'),
        this.#iconButton('🔍', t('search'), toggleSearch),
        this.#iconButton('⤓', t('exportHistory'), () => this.roomDialogs.exportHistory(room)),
        brokers,
        callButtons,
        membersBtn,
        h('button', { onclick: () => this.roomDialogs.invite(room) }, t('invite')),
        h('button', { class: 'ghost', onclick: () => this.roomDialogs.leave(room) }, t('leave'))),
      callBanner, searchBar, peers, conn, log, composer.quoteBar, composer.chips, composer.bar);

    this.#offStage.push(
      room.on('message', () => { drawLog(); this.#markViewed(); }),
      room.on('peers', drawPeers),
      room.on('files', () => drawLog()), // image previews start or wait with the transfers
      room.on('brokers', drawBrokers),
      holdToReveal(room, peers, conn));
    drawPeers(); drawBrokers(); drawLog(true); drawCall();
    composer.draw();
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











  // ---- linked devices ---------------------------------------------------------------------




  // ---- export ---------------------------------------------------------------------------------




  // ---- image cards ----------------------------------------------------------------------------












  // ---- dialogs ---------------------------------------------------------------------------------












}
