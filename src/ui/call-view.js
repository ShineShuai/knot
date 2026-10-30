// The call window: one tile per person plus the controls. It sits outside the room view, so
// a call goes on (and stays audible) while you read another room. Three layouts: full screen,
// "chat" (the call at the side, or on top on a phone, with the room's conversation next to it:
// text and files work as always) and "minimize" (a bar under the conversation, audio goes on).
// It only renders `room.call` and forwards clicks.
import { h } from './dom.js';
import { SpeakingMeter } from '../call/speaking.js';
import { t } from './i18n.js';

const SELF = 'self';
const initial = (name) => ([...name][0] ?? '?').toUpperCase();

export class CallPanel {
  #room = null; #offs = []; #tiles = new Map(); #notify;
  #mode = 'full';  // 'full' | 'chat' | 'mini'
  #before = 'full'; // what a minimized window goes back to
  #openChat; #onMode; #meter;

  /** `openChat(room)`: show that room's conversation; `onMode(mode)`: the layout changed. */
  constructor({ notify, openChat = () => {}, onMode = () => {}, speaking = {} }) {
    this.#notify = notify;
    this.#meter = new SpeakingMeter(speaking);
    this.#meter.on('change', () => this.#room && this.#draw()); // the highlight and the roster
    this.#openChat = openChat;
    this.#onMode = onMode;
    this.title = h('span', { class: 'call-title' });
    this.size = h('button', {
      class: 'ghost', onclick: () => this.#setMode(this.#mode === 'mini' ? this.#before : 'mini'),
    });
    this.grid = h('div', { class: 'call-grid' });
    this.mic = h('button', { class: 'round', onclick: () => this.#toggleMic() });
    this.cam = h('button', { class: 'round', onclick: () => this.#toggleCam() });
    this.share = h('button', { class: 'round', onclick: () => this.#toggleShare() });
    this.files = h('button', { class: 'round', onclick: () => this.#toggleFiles() });
    this.roster = h('span', { class: 'call-roster' });
    this.chatCount = h('span', { class: 'count', hidden: true });
    this.chatGlyph = h('span', { 'aria-hidden': 'true' }, '💬');
    this.chat = h('button', { class: 'round chat', onclick: () => this.#toggleChat() },
      this.chatGlyph, this.chatCount);
    this.leave = h(
      'button',
      { class: 'danger', onclick: () => this.#room?.call.leave() },
      t('callLeave'),
    );
    this.element = h('section', { class: 'call', hidden: true, 'aria-label': t('call') },
      h('header', { class: 'call-head' }, this.title, this.roster, this.size),
      this.grid,
      h('footer', { class: 'call-bar' }, this.mic, this.cam, this.share, this.files, this.chat,
        this.leave));
    this.#setMode('full', false);
  }

  /** The language changed: say everything again in the new one. */
  relabel() {
    this.element.setAttribute('aria-label', t('call'));
    this.leave.textContent = t('callLeave');
    this.#setMode(this.#mode, false);
    if (this.#room) this.#draw();
  }

  /** Does the call window hide this room's conversation right now? */
  covers(room) {
    return !!room && this.#room === room && !this.element.hidden && this.#mode === 'full';
  }

  /** Follow `room`'s call: show the window while we are in it, hide it otherwise. */
  sync(room) {
    if (room.call.joined) this.#show(room);
    else if (this.#room === room) this.#hide();
  }

  #show(room) {
    if (this.#room !== room) {
      this.#hide();
      this.#room = room;
      this.#offs = [room.on('unread', () => this.#drawChat()),
        room.on('files', () => this.#drawFiles())];
      this.#setMode('full');
    }
    this.#draw();
    this.element.hidden = false;
  }

  #hide() {
    for (const off of this.#offs) off();
    this.#offs = [];
    this.#meter.stop();
    this.#room = null;
    this.#tiles.clear();
    this.grid.replaceChildren();
    this.element.hidden = true;
    this.#setMode('full');
  }

  /** `tell`: let the page know (it adjusts its layout and marks what is now visible as read). */
  #setMode(mode, tell = true) {
    if (mode === 'mini' && this.#mode !== 'mini') this.#before = this.#mode;
    this.#mode = mode;
    this.element.dataset.mode = mode;
    const mini = mode === 'mini';
    const label = t(mini ? 'callExpand' : 'callMinimize');
    this.size.textContent = mini ? '▴' : '▾';
    this.size.title = label;
    this.size.setAttribute('aria-label', label);
    this.#drawChat();
    if (tell) this.#onMode(mode === 'chat' ? 'chat' : mode === 'mini' ? 'mini' : '');
  }

  /** Pause or resume file transfers on this device: a transfer shares the call's bandwidth. */
  #toggleFiles() { this.#room.setFileTransfer(!this.#room.fileTransfer); }

  #drawFiles() {
    const on = this.#room?.fileTransfer ?? true;
    this.#button(this.files, on ? '📎' : '⛔', t(on ? 'callFilesPause' : 'callFilesAllow'), !on);
  }

  #toggleChat() {
    this.#setMode(this.#mode === 'chat' ? 'full' : 'chat');
    if (this.#mode === 'chat' && this.#room) this.#openChat(this.#room);
  }

  /** The chat button: its label says what it does; the badge counts what is unread. */
  #drawChat() {
    const on = this.#mode === 'chat';
    const unread = on ? 0 : (this.#room?.unread ?? 0);
    const label = t(on ? 'callChatHide' : 'callChat');
    const full = unread ? `${label} (${t('unread', { n: unread })})` : label;
    this.chat.title = full;
    this.chat.setAttribute('aria-label', full);
    this.chat.setAttribute('aria-pressed', String(on));
    this.chatCount.hidden = !unread;
    this.chatCount.textContent = unread > 99 ? '99+' : String(unread);
  }

  async #toggleMic() {
    const { call } = this.#room;
    const wanted = !call.local.a;
    if (!(await call.setAudio(wanted)) && wanted) this.#notify(t('callNoMic'));
  }

  async #toggleCam() {
    const { call } = this.#room;
    const wanted = !call.local.v;
    if (!(await call.setVideo(wanted)) && wanted) this.#notify(t('callNoCam'));
  }

  async #toggleShare() {
    const { call } = this.#room;
    await call.setScreen(!call.local.s); // a cancelled picker is not worth a message
  }

  #draw() {
    const { call, label } = this.#room;
    const { a, v, s } = call.local;
    this.title.textContent = label || t('roomDefault');
    this.#button(this.mic, a ? '🎤' : '🔇', t(a ? 'callMute' : 'callUnmute'), a);
    this.#button(this.cam, v ? '🎥' : '🚫', t(v ? 'callCameraOff' : 'callCameraOn'), v);
    this.share.hidden = !call.canShare;
    this.#button(this.share, '🖥', t(s ? 'callShareStop' : 'callShare'), s);
    const people = [
      {
        id: SELF, name: t('you'), a, v: v || s, s, stream: call.localStream, state: 'connected',
      },
      ...call.participants.map((p) => ({ ...p, name: this.#room.nameOf(p.id) })),
    ];
    this.#listen(people);
    const gone = new Set(this.#tiles.keys());
    for (const person of people) {
      gone.delete(person.id);
      this.#drawTile(person);
    }
    for (const id of gone) {
      this.#tiles.get(id).el.remove();
      this.#tiles.delete(id);
    }
    this.#drawFiles();
    // Everyone is shown, whatever their camera or microphone does: the grid shares its space
    // out by head count, and the minimized bar names them.
    this.grid.dataset.count = String(people.length);
    const roster = people.map(
      (p) => `${p.name}${p.a ? '' : ' 🔇'}${p.state === 'connected' ? '' : ' …'}${
        this.#meter.isSpeaking(p.id) ? ' 🔊' : ''}`,
    ).join(', ');
    this.roster.textContent = roster;
    this.roster.title = roster;
  }

  /** Listen to everyone's audio (ours from the microphone) to highlight who is speaking. */
  #listen(people) {
    const streams = new Map(people.map(
      (p) => [p.id, p.id === SELF ? this.#room.call.micStream : p.stream],
    ));
    for (const [id, stream] of streams) {
      if (stream) this.#meter.watch(id, stream); else this.#meter.unwatch(id);
    }
    for (const id of this.#meter.ids()) if (!streams.has(id)) this.#meter.unwatch(id);
  }

  #button(el, glyph, label, on) {
    el.textContent = glyph;
    el.title = label;
    el.setAttribute('aria-label', label);
    el.setAttribute('aria-pressed', String(on));
  }

  /** Tiles are created once and updated in place: a video element must not be rebuilt. */
  #drawTile({ id, name, a, v, s, stream, state }) {
    let tile = this.#tiles.get(id);
    if (!tile) {
      const video = h('video', { autoplay: true, playsinline: true, muted: id === SELF });
      const avatar = h('div', { class: 'avatar', 'aria-hidden': 'true' });
      const label = h('span', { class: 'tile-name' });
      const status = h('span', { class: 'tile-status' });
      const el = h('figure', { class: id === SELF ? 'tile self' : 'tile' },
        video, avatar, h('figcaption', {}, label, status));
      tile = { el, video, avatar, label, status };
      this.#tiles.set(id, tile);
      this.grid.append(el);
    }
    if (tile.video.srcObject !== stream) {
      tile.video.srcObject = stream;
      tile.video.play?.()?.catch(() => {}); // autoplay can refuse; the next tap starts it
    }
    tile.el.classList.toggle('novideo', !(v && stream));
    tile.el.classList.toggle('sharing', !!s);
    tile.el.classList.toggle('speaking', this.#meter.isSpeaking(id));
    tile.avatar.textContent = initial(name);
    tile.label.textContent = name;
    const quiet = state !== 'connected' ? t('callConnecting') : a ? '' : '🔇';
    tile.status.textContent = s ? `🖥 ${quiet}`.trim() : quiet;
  }
}
