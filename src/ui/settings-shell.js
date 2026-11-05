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

/** Apply and Revert, hidden until something is changed (`watch` the part of the page that holds
 *  the controls). Revert is up to the page: it draws itself again from what is saved. */
export function applyBar(onApply, onRevert) {
  const apply = h('button', { class: 'primary', onclick: () => onApply() }, t('apply'));
  const node = h('div', { class: 'apply', hidden: true }, apply,
    h('button', { onclick: () => onRevert() }, t('revert')));
  const show = () => { node.hidden = false; };
  return {
    node,
    apply,
    show,
    hide: () => { node.hidden = true; },
    watch: (el) => { for (const type of ['input', 'change']) el.addEventListener(type, show); },
  };
}

export class SettingsShell {
  current = null; // the id of the page on show

  constructor(kit) { this.kit = kit; }

  /** `pages`: [{ id, label, scope?: { text, kind }, render({ refresh }) -> node }]. `start`: the
   *  page to open at; without it a wide screen shows the first page and a narrow one the list. */
  open(title, pages, start = null) {
    const cache = new Map();
    const buttons = new Map();
    const root = h('div', { class: 'sshell' });
    const body = h('div', { class: 'spage' });
    const draw = (id) => {
      const page = pages.find((p) => p.id === id);
      if (!cache.has(id)) {
        cache.set(id, page.render({ refresh: () => { cache.delete(id); draw(id); } }));
      }
      body.replaceChildren(
        h('button', { class: 'ghost sback', onclick: () => { root.dataset.view = 'list'; } },
          `‹ ${title}`),
        h('div', { class: 'ph' }, h('h3', {}, page.label),
          page.scope ? chip(page.scope.text, page.scope.kind) : null),
        cache.get(id),
      );
      for (const [key, button] of buttons) button.setAttribute('aria-current', key === id);
      root.dataset.view = 'page';
      this.current = id;
    };
    const nav = h('nav', { class: 'snav', 'aria-label': title }, ...pages.map((page) => {
      const button = h('button', { onclick: () => draw(page.id) }, page.label);
      buttons.set(page.id, button);
      return button;
    }));
    root.append(nav, body);
    const first = pages.some((p) => p.id === start) ? start : pages[0].id;
    draw(first);
    root.dataset.view = start ? 'page' : 'list';
    this.kit.open(title, root);
    this.kit.dialog.classList.add('shell');
  }
}
