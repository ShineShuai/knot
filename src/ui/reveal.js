// Hold V (or press and hold the member strip) to see how everyone is connected.
import { h } from './dom.js';
import { connLine } from './conn.js';
import { t } from './i18n.js';

/** Hold V (or press and hold the member strip) to see how everyone is connected. */
export function holdToReveal(room, strip, panel) {
  let timer = null;
  let press = null;
  const refresh = async () => {
    const rows = await room.connectionInfo();
    panel.replaceChildren(...rows.map((row) => h('div', {}, connLine(row, t))));
  };
  const reveal = (on) => {
    clearInterval(timer);
    panel.hidden = !on;
    if (on) { refresh(); timer = setInterval(refresh, 1000); }
  };
  const typing = (e) => /^(input|textarea|select)$/i.test(e.target.tagName)
    || e.target.isContentEditable;
  const down = (e) => {
    const plain = !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (plain && e.key.toLowerCase() === 'v' && !typing(e)) reveal(true);
  };
  const up = (e) => { if (e.key.toLowerCase() === 'v') reveal(false); };
  const off = () => reveal(false);
  const start = () => { press = setTimeout(() => reveal(true), 450); };
  const stop = () => { clearTimeout(press); reveal(false); };
  document.addEventListener('keydown', down);
  document.addEventListener('keyup', up);
  window.addEventListener('blur', off);
  strip.addEventListener('pointerdown', start);
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
    strip.addEventListener(type, stop);
  }
  return () => {
    reveal(false);
    clearTimeout(press);
    document.removeEventListener('keydown', down);
    document.removeEventListener('keyup', up);
    window.removeEventListener('blur', off);
  };
}
