// The image cards of the open conversation: one per shared image, kept across redraws so
// loading never rebuilds the chat; the lightbox; and the "is it on screen yet" observer.
import { h } from './dom.js';
import { ImageCard } from './image-card.js';

export class ImageCards {
  #cards = new Map();    // "<room id>:<file id>" -> ImageCard (keeps its DOM across redraws)
  #watching = new Map(); // element -> callback for when it scrolls into view
  #seen = null;          // IntersectionObserver

  constructor(ui) {
    this.ui = ui;
  }

  /** A new stage is drawn: stop waiting for elements that are gone. */
  reset() {
    this.#seen?.disconnect();
    this.#watching.clear();
  }

  /** The language changed: the cards' labels are baked in. */
  disposeAll() {
    for (const card of this.#cards.values()) card.dispose();
    this.#cards.clear();
  }

  disposeRoom(roomId) {
    for (const [key, card] of this.#cards) {
      if (key.startsWith(`${roomId}:`)) { card.dispose(); this.#cards.delete(key); }
    }
  }

  /** A message was deleted: drop its card. */
  forget(roomId, fileId) {
    const key = `${roomId}:${fileId}`;
    this.#cards.get(key)?.dispose();
    this.#cards.delete(key);
  }

  card(room, env) {
    if (!env.body.img || room.settings.imagePreviews === 'off') return null;
    const key = `${room.id}:${env.id}`;
    let card = this.#cards.get(key);
    if (!card) {
      const host = {
        notify: (text) => this.ui.notify(text),
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
    this.ui.dialog.addEventListener('close', () => { off(); sync(); }, { once: true });
    this.ui.kit.open(card.name, img, h('div', { class: 'actions' }, node));
    this.ui.dialog.classList.add('wide');
  }
}
