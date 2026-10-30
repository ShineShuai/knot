// One shared image in the message log. It owns its DOM, so the log can be rebuilt freely
// (the same element is handed out again) and loading never redraws the whole chat.
//
//   thumbnail  decoded from the envelope at once (blurred), the box is sized from w/h
//   preview    fetched when the card scrolls into view (or on tap), then sharp
//   original   loaded on request; shown in the lightbox, offered for saving
// Every blob is re-typed by sniffing its bytes (image.js); SVG is only ever an <img>.
import { Emitter } from '../util/emitter.js';
import { authorIdOf, previewRef } from '../chat/envelope.js';
import { LIMITS, asImage, thumbBlob } from '../files/image.js';
import { fmtSize, h, safeFileName } from './dom.js';
import { t } from './i18n.js';
import { record } from './diagnostics.js';

const SHOW = { w: 320, h: 384 }; // largest size of an image inside a message, in CSS px
const PARALLEL = 2; // previews fetched at the same time, across all cards

let running = 0;
const waiting = [];
async function inTurn(fn) {
  if (running >= PARALLEL) await new Promise((resolve) => waiting.push(resolve));
  else running++;
  try { return await fn(); } finally {
    const next = waiting.shift();
    if (next) next(); // hand the slot over
    else running--;
  }
}

export class ImageCard extends Emitter {
  /** Null if the envelope's thumbnail is not a sane image (the caller shows a file card). */
  static create(room, env, host) {
    const thumb = thumbBlob(env.body.img);
    return thumb ? new ImageCard(room, env, host, thumb) : null;
  }

  preview = 'idle'; // idle | loading | ready | failed
  original = { state: 'idle', pct: 0, url: null, view: null }; // idle | loading | done
  previewUrl = null;
  #urls = new Set();
  #room; #env; #host; #img; #note; #thumbUrl;

  constructor(room, env, host, thumb) {
    super();
    Object.assign(this, { name: env.body.name });
    [this.#room, this.#env, this.#host] = [room, env, host];
    const { name, size, img } = env.body;
    this.#thumbUrl = this.#url(thumb);
    // The size comes from the width and height attributes, not from style: Safari applies the
    // page's CSP to inline styles, even those set from script, and the card collapsed.
    const scale = Math.min(1, SHOW.w / img.w, SHOW.h / img.h);
    const width = Math.max(48, Math.round(img.w * scale));
    const height = Math.max(1, Math.round((width * img.h) / img.w));
    this.#img = h('img', {
      alt: name, src: this.#thumbUrl, decoding: 'async', class: 'low', width, height,
    });
    this.#note = h('span', { class: 'imgnote', role: 'status' });
    const button = h('button', {
      type: 'button',
      class: 'imgbtn',
      'aria-label': t('openImage', { name }),
      onclick: () => this.#tap(),
    }, this.#img, this.#note);
    this.el = h('figure', { class: 'imgcard' }, button,
      h('figcaption', { class: 'imgcap' },
        h('span', { class: 'file-name' }, name),
        h('span', { class: 'file-size' }, fmtSize(size)),
        img.a ? h('span', { class: 'badge' }, t('animated')) : null,
        this.actions().node));
    this.#paintNote();
  }

  get #own() { return this.#room.isMine(authorIdOf(this.#env)); }
  get #ref() { return previewRef(this.#env.body); }

  /** Best image we have right now. */
  currentUrl() { return this.original.view ?? this.previewUrl ?? this.#thumbUrl; }

  /** Call whenever the card is put on screen: arranges loading for when it is visible. */
  mount() {
    const auto = (this.#own || this.#room.settings.imagePreviews === 'auto')
      && this.#room.fileTransfer !== false; // paused for a call: wait, the log redraws later
    if (this.preview === 'idle' && this.#ref && auto) {
      this.#host.watch(this.el, () => this.load());
    }
  }

  async load() {
    if (this.preview === 'loading' || this.preview === 'ready') return;
    this.#setPreview('loading');
    try {
      const blob = await inTurn(() => this.#room.previewBlob(this.#env));
      if (!blob) throw new Error('no preview');
      this.previewUrl = this.#url(blob);
      this.#img.src = this.previewUrl;
      this.#img.classList.remove('low');
      if (this.#ref.id === this.#env.body.id) { // a tiny original is its own preview
        Object.assign(this.original, { state: 'done', url: this.previewUrl });
      }
      this.#setPreview('ready');
    } catch (err) {
      record('preview', err);
      this.#setPreview('failed');
    }
  }

  async loadOriginal() {
    const o = this.original;
    if (o.state !== 'idle') return;
    Object.assign(o, { state: 'loading', pct: 0 });
    this.emit('change');
    try {
      const blob = await this.#room.downloadFile(this.#env, (got, total) => {
        const pct = Math.floor((got / total) * 100);
        if (pct !== o.pct) { o.pct = pct; this.emit('change'); }
      });
      o.url = this.#url(blob);
      const view = await asImage(blob, LIMITS.originalPixels);
      if (view) o.view = this.#url(view);
      o.state = 'done';
    } catch (err) {
      o.state = 'idle';
      this.#host.notify(err.message);
    }
    this.emit('change');
  }

  /** Save/progress/"Original" control; live-updates itself. Call `off` to stop updating. */
  actions() {
    const node = h('span', { class: 'imgact' });
    const draw = () => node.replaceChildren(...this.#actionNodes());
    const off = this.on('change', draw);
    draw();
    return { node, off };
  }

  dispose() { for (const url of this.#urls) URL.revokeObjectURL(url); this.#urls.clear(); }

  #actionNodes() {
    const { name, size } = this.#env.body;
    const o = this.original;
    if (o.state === 'done') {
      const attrs = { class: 'button', href: o.url, download: safeFileName(name) };
      return [h('a', attrs, t('saveFile'))];
    }
    if (o.state === 'loading') return [h('span', { class: 'file-size' }, t('receiving', o))];
    return [h('button', { onclick: () => this.loadOriginal() },
      t('loadOriginal', { size: fmtSize(size) }))];
  }

  #tap() {
    if (this.#ref && this.preview !== 'ready') {
      if (this.#room.fileTransfer === false) return this.#host.notify(t('filesOff'));
      if (this.preview !== 'loading') this.load();
    } else this.#host.open(this);
  }

  #setPreview(state) {
    this.preview = state;
    this.#paintNote();
    this.emit('change');
  }

  #paintNote() {
    const text = {
      loading: t('previewLoading'),
      failed: t('previewFailed'),
      idle: this.#ref && this.#room.settings.imagePreviews === 'tap' && !this.#own
        ? t('loadPreview', { size: fmtSize(this.#ref.size) }) : '',
    };
    this.#note.textContent = text[this.preview] ?? '';
  }

  #url(blob) {
    const url = URL.createObjectURL(blob);
    this.#urls.add(url);
    return url;
  }
}
