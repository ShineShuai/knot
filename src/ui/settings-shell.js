// The frame of the settings: a list of pages beside the page you picked (on a narrow screen
// they take turns), and the small parts the pages are made of. A page is drawn when it is first
// opened and kept, so what was typed on one page is still there after a visit to another. Only
// the open page is in the document.
import { h } from './dom.js';
import { t } from './i18n.js';

/** A small label, e.g. who a setting reaches. `kind`: '' | 'me' | 'room' (the colour). */
export const chip = (text, kind = '') => h('em', { class: `chip ${kind}`.trim() }, text);

/** A label above a control. */
export const field = (label, control) => h(
  'label',
  { class: 'field' },
  h('span', {}, label),
  control,
);

/** A row with a switch: the label (and a hint below it) left, the switch right. `input` is a
 *  checkbox made by the caller. */
export const switchRow = (label, input, hint = null) => h(
  'label',
  { class: 'row' },
  h('span', {}, label, hint ? h('small', {}, hint) : null),
  h('span', { class: 'sw' }, input, h('i')),
);

/** Apply (or `label`) and Revert, hidden until something is changed (`watch` the part of the
 *  page that holds the controls). Revert is up to the page: it draws itself again from what is
 *  saved. */
export function applyBar(onApply, onRevert, label = t('apply')) {
  const apply = h('button', { class: 'primary', onclick: () => onApply() }, label);
  const node = h('div', { class: 'apply', hidden: true }, apply,
    h('button', { onclick: () => onRevert() }, t('revert')));
  const show = () => { node.hidden = false; };
  return {
    node,
    apply,
    show,
    hide: () => {
      const here = node.contains?.(globalThis.document?.activeElement);
      node.hidden = true;
      // a hidden button must not take the focus with it: back to the top of the page
      if (here) node.closest?.('.spage')?.querySelector('h3')?.focus?.();
    },
    watch: (el) => { for (const type of ['input', 'change']) el.addEventListener(type, show); },
  };
}

export class SettingsShell {
  current = null; // the id of the page on show
  cache = new Map(); // id -> the page, drawn once and kept
  updateBadges = () => {};

  constructor(kit) { this.kit = kit; }

  /** Does a page hold changes that were not applied (its Apply bar is showing)? */
  get pending() {
    return [...this.cache.values()].some(
      (node) => [...node.querySelectorAll('.apply')].some((bar) => !bar.hidden),
    );
  }

  /** `pages`: [{ id, label, scope?: { text, kind }, badge?, danger?, render({ refresh }) ->
   *  node }] (`badge`: a count beside the label, or a function that gives it: see
   *  `updateBadges`). `start`: the
   *  page to open at; without it a wide screen shows the first page and a narrow one the list. */
  open(title, pages, start = null) {
    const { cache } = this;
    const buttons = new Map();
    const marks = new Map(); // id -> the count beside its label
    const root = h('div', { class: 'sshell' });
    const body = h('div', { class: 'spage', role: 'region', 'aria-labelledby': 'spage-title' });
    let heading = null;
    // On a narrow screen the list and the page take turns; then the list is not on screen.
    const listHidden = () => globalThis.getComputedStyle?.(nav).display === 'none';
    /** `how`: 'pick' (the person chose a page: on a narrow screen the focus moves to it),
     *  'again' (drawn anew, e.g. after Revert: keep the focus in the page if it was there). */
    const draw = (id, how = null) => {
      const page = pages.find((p) => p.id === id);
      const focused = body.contains?.(globalThis.document?.activeElement);
      if (!cache.has(id)) {
        cache.set(id, page.render({ refresh: () => { cache.delete(id); draw(id, 'again'); } }));
      }
      heading = h('h3', { id: 'spage-title', tabIndex: -1 }, page.label);
      body.replaceChildren(
        h('button', {
          class: 'ghost sback', 'aria-label': t('backTo', { title }),
          onclick: () => { root.dataset.view = 'list'; buttons.get(this.current)?.focus(); },
        }, `‹ ${title}`),
        h('div', { class: 'ph' }, heading,
          page.scope ? chip(page.scope.text, page.scope.kind) : null),
        cache.get(id),
      );
      for (const [key, button] of buttons) button.setAttribute('aria-current', key === id);
      root.dataset.view = 'page';
      this.current = id;
      if ((how === 'pick' && listHidden()) || (how === 'again' && focused)) heading.focus();
    };
    const nav = h('nav', { class: 'snav', 'aria-label': title }, ...pages.map((page) => {
      const count = () => (typeof page.badge === 'function' ? page.badge() : page.badge) || 0;
      const mark = page.badge === undefined ? null
        : h('em', { class: 'count', hidden: !count() }, count() ? String(count()) : '');
      if (mark) marks.set(page.id, [mark, count]);
      const button = h('button', {
        class: page.danger ? 'dn' : '', onclick: () => draw(page.id, 'pick'),
      }, page.label, mark);
      buttons.set(page.id, button);
      return button;
    }));
    this.updateBadges = () => {
      for (const [mark, count] of marks.values()) {
        mark.textContent = count() ? String(count()) : '';
        mark.hidden = !count();
      }
    };
    root.append(nav, body);
    const first = pages.some((p) => p.id === start) ? start : pages[0].id;
    draw(first);
    root.dataset.view = start ? 'page' : 'list';
    this.kit.open(title, root);
    this.kit.dialog.classList.add('paged');
    this.kit.guard = () => !this.pending || confirm(t('discardChanges'));
    // the screen reader starts at the pages (or at the page, where the list is not shown)
    if (root.dataset.view === 'page' && listHidden()) heading.focus();
    else buttons.get(this.current)?.focus();
  }
}
