// Tiny DOM helpers. Text is always inserted as text nodes, never as HTML.
const SVG_NS = 'http://www.w3.org/2000/svg';

/** h('button', { class: 'x', onclick }, 'label', child...) */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key in el) el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

/** Inline SVG for a QR matrix (always black on white so scanners work in dark mode too). */
export function qrSvg(pathData, size, label) {
  const total = size + 8;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${total} ${total}`);
  svg.setAttribute('class', 'qr');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  const bg = document.createElementNS(SVG_NS, 'rect');
  const bgAttrs = { width: total, height: total, fill: '#fff' };
  for (const [k, v] of Object.entries(bgAttrs)) bg.setAttribute(k, v);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', pathData);
  path.setAttribute('fill', '#000');
  svg.append(bg, path);
  return svg;
}

export const fmtSize = (n) => (
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB`
    : `${(n / 1048576).toFixed(1)} MB`
);
const UNSAFE_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;
export const safeFileName = (name) =>
  name.replace(UNSAFE_FILENAME_CHARS, '_').slice(0, 120) || 'file';
