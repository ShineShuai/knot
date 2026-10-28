// The call window: one tile per person plus the controls. It sits outside the room view, so
// a call goes on (and stays audible) while you read another room; "minimize" folds it into a
// bar. It only renders `room.call` and forwards clicks.
import { h } from './dom.js';
import { t } from './i18n.js';

const SELF = 'self';
const initial = (name) => ([...name][0] ?? '?').toUpperCase();

export class CallPanel {
  #room = null; #off = null; #tiles = new Map(); #mini = false; #notify;

  constructor({ notify }) {
    this.#notify = notify;
    this.title = h('span', { class: 'call-title' });
    this.size = h('button', { class: 'ghost', onclick: () => this.#fold(!this.#mini) });
    this.grid = h('div', { class: 'call-grid' });
    this.mic = h('button', { class: 'round', onclick: () => this.#toggleMic() });
    this.cam = h('button', { class: 'round', onclick: () => this.#toggleCam() });
    this.leave = h(
      'button',
      { class: 'danger', onclick: () => this.#room?.call.leave() },
      t('callLeave'),
    );
    this.element = h('section', { class: 'call', hidden: true, 'aria-label': t('call') },
      h('header', { class: 'call-head' }, this.title, this.size),
      this.grid,
      h('footer', { class: 'call-bar' }, this.mic, this.cam, this.leave));
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
      this.#fold(false);
    }
    this.#draw();
    this.element.hidden = false;
  }

  #hide() {
    this.#room = null;
    this.#tiles.clear();
    this.grid.replaceChildren();
    this.element.hidden = true;
  }

  #fold(mini) {
    this.#mini = mini;
    this.element.dataset.mini = String(mini);
    const label = t(mini ? 'callExpand' : 'callMinimize');
    this.size.textContent = mini ? '▴' : '▾';
    this.size.title = label;
    this.size.setAttribute('aria-label', label);
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

  #draw() {
    const { call, label } = this.#room;
    const { a, v } = call.local;
    this.title.textContent = label || t('roomDefault');
    this.#button(this.mic, a ? '🎤' : '🔇', t(a ? 'callMute' : 'callUnmute'), a);
    this.#button(this.cam, v ? '🎥' : '🚫', t(v ? 'callCameraOff' : 'callCameraOn'), v);
    const people = [
      { id: SELF, name: t('you'), a, v, stream: call.localStream, state: 'connected' },
      ...call.participants.map((p) => ({ ...p, name: this.#room.nameOf(p.id) })),
    ];
    const gone = new Set(this.#tiles.keys());
    for (const person of people) {
      gone.delete(person.id);
      this.#drawTile(person);
    }
    for (const id of gone) {
      this.#tiles.get(id).el.remove();
      this.#tiles.delete(id);
    }
  }

  #button(el, glyph, label, on) {
    el.textContent = glyph;
    el.title = label;
    el.setAttribute('aria-label', label);
    el.setAttribute('aria-pressed', String(on));
  }

  /** Tiles are created once and updated in place: a video element must not be rebuilt. */
  #drawTile({ id, name, a, v, stream, state }) {
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
    tile.avatar.textContent = initial(name);
    tile.label.textContent = name;
    tile.status.textContent = state !== 'connected' ? t('callConnecting') : a ? '' : '🔇';
  }
}
