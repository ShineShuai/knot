// Browser notifications for messages that arrive while their room is not on screen (another
// room, another tab or window). Nothing is sent through any server: they only work while the
// app is open somewhere, and messages arriving together (history catching up) become one
// notification per room.
import { t } from './i18n.js';

const WAIT_MS = 400;
const PREVIEW_CHARS = 120;

export const browserEnv = {
  supported: () => typeof Notification !== 'undefined',
  permission: () => Notification.permission,
  request: () => Notification.requestPermission(),
  /** Through the service worker when there is one (phones require it; sw.js handles the
   *  click), else directly. */
  async show(title, options, onclick) {
    const registration = await globalThis.navigator?.serviceWorker?.getRegistration?.();
    if (registration?.showNotification) return registration.showNotification(title, options);
    const note = new Notification(title, options);
    note.onclick = () => { window.focus(); onclick(); note.close(); };
    return undefined;
  },
};

export class Notifier {
  #pending = new Map(); // room id -> { envs, timer }

  /** settings: live settings object (`notifications`); isActive(room): is it on screen now?;
   *  open(roomId): bring that room up (a notification was clicked). */
  constructor({ settings, isActive, open, env = browserEnv }) {
    Object.assign(this, { settings, isActive, open, env });
  }

  get supported() { return this.env.supported(); }

  /** Ask the browser for permission (call from a click). True if notifications can show. */
  async enable() {
    if (!this.supported) return false;
    if (this.env.permission() === 'default') await this.env.request();
    return this.env.permission() === 'granted';
  }

  /** Follow a room's incoming messages; returns the function that stops following. */
  watch(room) { return room.on('incoming', (env) => this.#incoming(room, env)); }

  #incoming(room, env) {
    const on = this.settings.notifications && this.supported && this.env.permission() === 'granted';
    if (!on || this.isActive(room)) return;
    const entry = this.#pending.get(room.id) ?? { envs: [], timer: null };
    entry.envs.push(env);
    this.#pending.set(room.id, entry);
    if (entry.timer) return;
    entry.timer = setTimeout(() => this.#flush(room), WAIT_MS);
    entry.timer.unref?.();
  }

  #flush(room) {
    const { envs } = this.#pending.get(room.id);
    this.#pending.delete(room.id);
    if (this.isActive(room)) return; // the user got there first
    const last = envs.at(-1);
    const body = envs.length > 1 ? t('notifyMany', { n: envs.length }) : this.#preview(room, last);
    this.env.show(
      room.label || t('roomDefault'),
      { body, tag: room.id, data: { room: room.id } },
      () => this.open(room.id),
    ).catch(() => {}); // a notification that cannot be shown is not worth an error
  }

  #preview(room, env) {
    const text = env.kind === 'file' ? `📎 ${env.body.name}` : room.log.textOf(env);
    return `${env.name}: ${text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS)}`;
  }
}
