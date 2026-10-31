// A very small DOM, just enough to run the real UI code (src/ui/view.js) in Node: it catches
// ReferenceErrors, bad wiring and missing buttons that the unit tests cannot see.
// It does not lay anything out and knows nothing about CSS.
const matches = (el, sel) => {
  if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
  const attr = /^\[([\w-]+)="(.*)"\]$/.exec(sel);
  if (attr) return el.getAttribute(attr[1]) === attr[2];
  return el.tagName.toLowerCase() === sel;
};

export class FakeElement {
  parentNode = null;
  children = [];
  attrs = {};
  listeners = {};
  style = {};
  dataset = {};
  className = '';
  hidden = false;
  open = false;
  // Properties the UI sets or reads directly (a real element has these built in).
  value = ''; checked = false; disabled = false; type = ''; rows = 0; placeholder = '';
  title = ''; src = ''; alt = ''; href = ''; download = ''; maxLength = 0; multiple = false;
  selected = false; id = ''; name = ''; role = ''; decoding = '';

  constructor(tag) { this.tagName = tag.toUpperCase(); }

  get classList() {
    const el = this;
    const names = () => el.className.split(/\s+/).filter(Boolean);
    return {
      add: (n) => { if (!names().includes(n)) el.className = [...names(), n].join(' '); },
      remove: (n) => { el.className = names().filter((x) => x !== n).join(' '); },
      contains: (n) => names().includes(n),
      toggle: (n, on) => { el.classList[on ?? !names().includes(n) ? 'add' : 'remove'](n); },
    };
  }

  get isConnected() { return !!this.parentNode || this.tagName === 'BODY'; }
  get textContent() {
    return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
  set textContent(v) { this.replaceChildren(String(v)); }

  append(...nodes) {
    for (const n of nodes) {
      if (n instanceof FakeElement) { n.parentNode?.removeChild(n); n.parentNode = this; }
      this.children.push(n);
      if (this.tagName === 'SELECT' && n.selected) this.value = n.value; // as a real <select>
    }
  }
  appendChild(n) { this.append(n); return n; }
  removeChild(n) { this.children = this.children.filter((c) => c !== n); n.parentNode = null; }
  replaceChildren(...nodes) {
    for (const c of this.children) if (c instanceof FakeElement) c.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }
  remove() { this.parentNode?.removeChild(this); }

  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
  }

  /** Run the handlers of `type`, like the browser would. */
  fire(type, event = {}) {
    const e = { target: this, preventDefault() {}, stopPropagation() {}, ...event };
    for (const fn of [...(this.listeners[type] ?? [])]) fn(e);
    this[`on${type}`]?.(e);
  }
  click() { this.fire('click'); }

  *walk() {
    for (const c of this.children) if (c instanceof FakeElement) { yield c; yield* c.walk(); }
  }
  querySelectorAll(sel) { return [...this.walk()].filter((el) => matches(el, sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  closest(sel) {
    const first = sel.split(',')[0].trim();
    for (let el = this; el; el = el.parentNode) if (matches(el, first)) return el;
    return null;
  }

  focus() { FakeElement.focused = this; }
  showModal() { this.open = true; }
  close() { this.open = false; this.fire('close'); }
}

export function installFakeDom() {
  const document = new FakeElement('document');
  Object.assign(document, {
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (ns, tag) => new FakeElement(tag),
    execCommand: () => true,
  });
  const globals = {
    document,
    window: new FakeElement('window'),
    location: { origin: 'https://knot.test', pathname: '/', search: '', hash: '' },
    navigator: { clipboard: { writeText: async () => {} } },
    CSS: { escape: (s) => s },
    confirm: () => true,
    HTMLElement: FakeElement,
  };
  for (const [k, v] of Object.entries(globals)) {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  return { document, root: new FakeElement('div') };
}

/** Everything under `root` that has this tag and (part of) this text. */
export const find = (root, tag, text) => root.querySelectorAll(tag.toLowerCase()).filter(
  (el) => el.textContent.includes(text),
);
