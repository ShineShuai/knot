// One message of the conversation as a list item: text with links, replies, files and image
// cards, reactions with their emoji palette, notices and what is left of a deleted message.
import { ADMIN_KINDS, authorIdOf, isEmoji } from '../chat/envelope.js';
import { noticeLine } from '../chat/notice.js';
import { fmtSize, h, safeFileName } from './dom.js';
import { t } from './i18n.js';
import { linkify } from './linkify.js';
import { record } from './diagnostics.js';
import { MORE, QUICK } from './emoji.js';
import { withDevice } from './alias.js';

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export class Messages {
  #reactTo = null;       // id of the message whose emoji palette is open
  #reactMore = false;    // that palette shows every emoji, not just the quick row
  #downloads = new Map(); // file id -> { status, pct, url, error }

  constructor(ui) {
    this.ui = ui;
  }

  /** A new stage is drawn: no palette is open. */
  reset() {
    this.#reactTo = null;
    this.#reactMore = false;
  }

  /** `opts.onShow`: this is a search hit; its only action is to show it in the conversation. */
  render(room, env, redraw, opts = {}) {
    if (env.kind === 'gone') return this.#renderGone(room, env);
    if (ADMIN_KINDS.includes(env.kind)) return this.#renderNotice(room, env);
    const own = room.isMine(authorIdOf(env));
    const edited = room.log.isEdited(env);
    const parts = env.kind === 'file' ? [this.#renderFile(room, env, redraw)] : [
      env.kind === 'reply' ? this.#renderQuote(room, env.body.q) : null,
      h('p', { class: 'text' }, ...linkify(room.log.textOf(env)),
        edited ? h('span', { class: 'edited' }, ` (${t('edited')})`) : null),
    ];
    const button = (label, onclick) => h('button', { class: 'ghost', onclick }, label);
    const acts = h('span', { class: 'acts' }, ...(opts.onShow
      ? [button(t('searchShow'), () => opts.onShow(env))] : [
        button(t('reply'), () => this.ui.composer.setQuote(env)),
        button(t('react'), () => {
          this.#reactTo = this.#reactTo === env.id ? null : env.id;
          this.#reactMore = false;
          redraw();
        }),
        own && env.kind !== 'file'
          ? button(t('edit'), () => this.ui.composer.startEdit(room, env)) : null,
        own || room.isOwner ? button(t('deleteMsg'), () => this.#confirmDelete(room, env)) : null,
      ]));
    return h('li', { class: `msg ${own ? 'own' : 'other'}`, 'data-id': env.id },
      h('div', { class: 'meta' },
        withDevice(own ? t('you') : env.name, room.deviceOf(authorIdOf(env), env.cert?.n)),
        ' ', h('time', {}, clock(env.ms)), acts),
      ...parts,
      opts.onShow ? null : this.#renderReactions(room, env, redraw));
  }

  /** The emoji under a message (tap one to add or take back yours) and, if open, the palette. */
  #renderReactions(room, env, redraw) {
    const byEmoji = room.log.overlay().reactions.get(env.id);
    const open = this.#reactTo === env.id;
    if (!byEmoji && !open) return null;
    const me = room.identity.member;
    const toggle = (emoji) => {
      this.#reactTo = null;
      this.#reactMore = false;
      redraw();
      room.react(env.id, emoji).catch((err) => this.ui.notify(err.message));
    };
    const chips = [...(byEmoji ?? [])].map(([emoji, ids]) => h('button', {
      class: ids.includes(me) ? 'rx mine' : 'rx', 'aria-pressed': String(ids.includes(me)),
      title: ids.map((id) => (id === me ? t('you') : room.nameOf(id))).join(', '),
      onclick: () => toggle(emoji),
    }, `${emoji} ${ids.length}`));
    const pick = (emoji) => h(
      'button', { class: 'rx pick', title: emoji, onclick: () => toggle(emoji) }, emoji,
    );
    const more = this.#reactMore;
    const label = t(more ? 'reactLess' : 'reactMore');
    /** A box for any other emoji: typed, or pasted from the keyboard's emoji picker. */
    const anyEmoji = () => {
      const input = h('input', {
        type: 'text', class: 'rx-any', maxLength: 16, placeholder: t('reactAny'),
        'aria-label': t('reactAny'),
      });
      input.addEventListener('input', () => {
        const value = input.value.trim();
        if (isEmoji(value)) toggle(value);
      });
      return input;
    };
    const palette = !open ? null : h('span', { class: 'palette' },
      ...QUICK.map(pick),
      h('button', {
        class: 'rx more', 'aria-expanded': String(more), title: label, 'aria-label': label,
        onclick: () => { this.#reactMore = !more; redraw(); },
      }, more ? '−' : '＋'),
      more ? h('span', { class: 'palette-grid' }, ...MORE.map(pick), anyEmoji()) : null);
    return h('div', { class: 'reactions' }, ...chips, palette);
  }

  /** Membership changes, as one quiet line in the conversation. */
  #renderNotice(room, env) {
    return h('li', { class: 'msg gone', 'data-id': env.id },
      h('p', { class: 'text' }, noticeLine(room, env, t)));
  }

  /** What is left of a deleted message: who deleted it, in its old place. */
  #renderGone(room, item) {
    this.ui.images.forget(room.id, item.id);
    const text = room.isMine(item.by)
      ? t('youDeleted') : t('deletedBy', { name: item.name });
    return h('li', { class: 'msg gone', 'data-id': item.id }, h('p', { class: 'text' }, text));
  }

  #renderQuote(room, q) {
    const gone = room.log.isGone(q.id);
    return h('blockquote', {
      class: gone ? 'quote gone' : 'quote',
      onclick: () => !gone && this.jumpTo(q.id),
    }, h('b', {}, q.name), ' ', gone ? t('quoteDeleted') : q.text);
  }

  jumpTo(id) {
    const el = this.ui.stage.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1200);
  }

  #confirmDelete(room, env) {
    if (!confirm(t('deleteConfirm'))) return;
    room.deleteMessage(env.id).catch((err) => {
      record('delete', err);
      this.ui.notify(err.message);
    });
  }

  #renderFile(room, env, redraw) {
    const card = this.ui.images.card(room, env);
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
            this.ui.notify(err.message);
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
    const btn = this.ui.stage.querySelector(`[data-file-id="${CSS.escape(id)}"]`);
    if (btn) btn.textContent = t('receiving', { pct: this.#downloads.get(id).pct });
  }
}
