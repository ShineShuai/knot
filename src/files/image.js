// Image sniffing (header parsing only, nothing is decoded) and the sender-side derivation
// of the small renditions that travel with a shared image:
//   thumbnail  ~160 px, a few KB, inlined in the signed file envelope
//   preview    <= 1280 px, <= 600 KB, fetched on demand like a tiny file
// Peers never trust a claimed mime type: they sniff the bytes and check the pixel count
// from the header before the browser is asked to decode anything.
//
// SVG is accepted, but only as an <img> source: scripts do not run and nothing external
// loads there. It must never be opened as a document (navigation, <object>, inline).
import { fromB64u, toB64u } from '../util/bytes.js';

export const LIMITS = Object.freeze({
  thumbTarget: 6 * 1024, // what the sender aims for
  thumbMax: 10 * 1024, // what receivers accept
  previewMax: 600 * 1024,
  ownPreviewMax: 300 * 1024, // an original this small is its own preview
  svgMax: 2 * 1024 * 1024, // SVG is only accepted whole, and at most this big
  pixels: 2 ** 24, // thumbnails and previews: 16 megapixels
  originalPixels: 2 ** 26, // originals decoded by the sender or shown in the lightbox
});
export const PREVIEW_TYPES = Object.freeze(['image/jpeg', 'image/webp', 'image/png']);
export const THUMB_TYPES = Object.freeze([...PREVIEW_TYPES, 'image/svg+xml']);
const SNIFF_PREFIX = 256 * 1024;

// ---- header sniffing -------------------------------------------------------------------

const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const ascii = (b, i, s) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));

const sniffPng = (b) => (
  b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 'PNG\r\n\x1a\n') && ascii(b, 12, 'IHDR')
    ? { type: 'image/png', w: u32be(b, 16), h: u32be(b, 20) } : null
);

function sniffJpeg(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) i++; // padding
    else if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) i += 2; // markers without a length
    else if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) {
      return { type: 'image/jpeg', h: u16be(b, i + 5), w: u16be(b, i + 7) };
    } else if (m === 0xda) return null; // scan data before any frame header
    else i += 2 + u16be(b, i + 2);
  }
  return null;
}

const sniffGif = (b) => (
  b.length >= 10 && ascii(b, 0, 'GIF8') && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61
    ? { type: 'image/gif', w: u16le(b, 6), h: u16le(b, 8) } : null
);

function sniffWebp(b) {
  if (b.length < 30 || !ascii(b, 0, 'RIFF') || !ascii(b, 8, 'WEBP')) return null;
  const type = 'image/webp';
  if (ascii(b, 12, 'VP8X')) return { type, w: 1 + u24le(b, 24), h: 1 + u24le(b, 27) };
  if (ascii(b, 12, 'VP8L') && b[20] === 0x2f) {
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
    return { type, w: 1 + (bits & 0x3fff), h: 1 + ((bits >>> 14) & 0x3fff) };
  }
  if (ascii(b, 12, 'VP8 ') && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return { type, w: u16le(b, 26) & 0x3fff, h: u16le(b, 28) & 0x3fff };
  }
  return null;
}

const SVG_FORBIDDEN = /<!entity|<script/i;

function svgSize(tag) {
  const length = (name) => {
    const m = new RegExp(`\\s${name}\\s*=\\s*["']\\s*([0-9.]+)(?:px)?\\s*["']`, 'i').exec(tag);
    return m ? Math.round(parseFloat(m[1])) : 0;
  };
  let [w, h] = [length('width'), length('height')];
  if (!(w > 0 && h > 0)) {
    const num = '[-0-9.e+]+';
    const box = new RegExp(
      `\\sviewBox\\s*=\\s*["']\\s*${num}[\\s,]+${num}[\\s,]+(${num})[\\s,]+(${num})\\s*["']`,
      'i',
    ).exec(tag);
    [w, h] = box ? [Math.round(parseFloat(box[1])), Math.round(parseFloat(box[2]))] : [0, 0];
  }
  const clamp = (n) => (n > 0 ? Math.min(n, 65535) : 0);
  return { w: clamp(w), h: clamp(h) };
}

function sniffSvg(b, total) {
  if (b.length !== total || total < 8 || total > LIMITS.svgMax) return null;
  let s;
  try { s = new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return null; }
  if (SVG_FORBIDDEN.test(s)) return null;
  let i = s.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) { // skip whitespace, <?xml?>, comments and a DOCTYPE without internal subset
    while (i < s.length && /\s/.test(s[i])) i++;
    const close = s.startsWith('<?', i) ? '?>' : s.startsWith('<!--', i) ? '-->'
      : /^<!doctype\s/i.test(s.slice(i, i + 10)) ? '>' : null;
    if (!close) break;
    const end = s.indexOf(close, i + 2);
    if (end < 0 || (close === '>' && s.slice(i, end).includes('['))) return null;
    i = end + close.length;
  }
  const tag = /^<svg\b[^>]*>/i.exec(s.slice(i, i + 4096));
  return tag ? { type: 'image/svg+xml', ...svgSize(tag[0]) } : null;
}

/** { type, w, h } from the bytes alone, or null. `total` is the full file size: SVG is
 *  only accepted when `bytes` is the whole file, because it has no header to trust. */
export function sniffImage(bytes, total = bytes.length) {
  return sniffPng(bytes) ?? sniffJpeg(bytes) ?? sniffGif(bytes) ?? sniffWebp(bytes)
    ?? sniffSvg(bytes, total);
}

export const pixelsOk = (info, max = LIMITS.pixels) => (
  info.type === 'image/svg+xml' || (info.w >= 1 && info.h >= 1 && info.w * info.h <= max)
);

/** Re-type a blob by its content. Null unless it is an image we are willing to display. */
export async function asImage(blob, maxPixels = LIMITS.pixels) {
  const n = blob.size <= LIMITS.svgMax ? blob.size : SNIFF_PREFIX;
  const info = sniffImage(new Uint8Array(await blob.slice(0, n).arrayBuffer()), blob.size);
  return info && pixelsOk(info, maxPixels) ? blob.slice(0, blob.size, info.type) : null;
}

/** The inline thumbnail of an envelope's `img` as a typed Blob, or null if it is not sane. */
export function thumbBlob({ t, tm }) {
  let bytes;
  try { bytes = fromB64u(t); } catch { return null; }
  const info = bytes.length <= LIMITS.thumbMax ? sniffImage(bytes) : null;
  return info && info.type === tm && pixelsOk(info) ? new Blob([bytes], { type: tm }) : null;
}

// ---- animation -----------------------------------------------------------------------------

function gifFrames(b) {
  const past = (i) => { // skip data sub-blocks and their terminator
    while (i < b.length && b[i]) i += b[i] + 1;
    return i + 1;
  };
  const table = (packed) => (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
  let [i, frames] = [13 + table(b[10]), 0];
  while (i < b.length && b[i] !== 0x3b) {
    if (b[i] === 0x21) i = past(i + 2);
    else if (b[i] === 0x2c) { frames++; i = past(i + 11 + table(b[i + 9])); } else break;
  }
  return frames;
}

function isAnimated(b, type) {
  if (type === 'image/gif') return gifFrames(b) > 1;
  if (type === 'image/webp') return ascii(b, 12, 'VP8X') && !!(b[20] & 0x02);
  if (type === 'image/png') {
    for (let i = 8; i + 8 <= b.length; i += 12 + u32be(b, i)) {
      if (ascii(b, i + 4, 'acTL')) return true;
      if (ascii(b, i + 4, 'IDAT')) break;
    }
  }
  return false;
}

// ---- sender side: derive thumbnail and preview ------------------------------------------

const THUMB_SIDES = [160, 128, 96, 64];
const THUMB_QUALITY = [0.7, 0.5, 0.35];
const PREVIEW_SIDES = [1280, 1024, 800];
const PREVIEW_QUALITY = [0.82, 0.7, 0.55];

/** First rendition (largest side, best quality) that fits `cap` bytes, or null. */
async function fit(src, sides, qualities, cap) {
  for (const side of sides) {
    for (const quality of qualities) {
      const blob = await src.encode(side, quality);
      if (blob && blob.size <= cap && PREVIEW_TYPES.includes(blob.type)) return blob;
    }
  }
  return null;
}

/**
 * Renditions for a file the user is about to share, or null if it is not an image we can
 * handle (the caller then shares a plain file).
 *   -> { img: { w, h, t, tm, a? }, preview: Blob | null }
 * `preview` is null when the original is small enough to be its own preview.
 * `io` is the browser glue (see browserIo); tests pass a fake.
 */
export async function deriveImage(file, bytes, io = browserIo()) {
  if (!io) return null;
  const sniffed = sniffImage(bytes);
  if (!sniffed && !file.type.startsWith('image/')) return null; // e.g. AVIF, BMP, HEIC
  if (sniffed && !pixelsOk(sniffed, LIMITS.originalPixels)) return null;
  const svg = sniffed?.type === 'image/svg+xml';
  if (svg && !(sniffed.w && sniffed.h)) return null; // no intrinsic size to lay out
  const src = await io.decode(file, svg ? { bytes, w: sniffed.w, h: sniffed.h } : null);
  try {
    const { w, h } = src;
    if (!(w >= 1 && h >= 1 && w <= 65535 && h <= 65535 && w * h <= LIMITS.originalPixels)) {
      return null;
    }
    const thumb = svg && bytes.length <= LIMITS.thumbTarget
      ? new Blob([bytes], { type: 'image/svg+xml' }) // tiny vector: crisp at any size
      : await fit(src, THUMB_SIDES, THUMB_QUALITY, LIMITS.thumbTarget);
    if (!thumb) return null;
    const own = !!sniffed && bytes.length <= LIMITS.ownPreviewMax && pixelsOk(sniffed);
    const preview = own ? null
      : await fit(src, PREVIEW_SIDES, PREVIEW_QUALITY, LIMITS.previewMax);
    const t = toB64u(new Uint8Array(await thumb.arrayBuffer()));
    const img = { w, h, t, tm: thumb.type };
    if (isAnimated(bytes, sniffed?.type)) img.a = 1;
    return { img, preview };
  } finally { src.free?.(); }
}

// ---- browser glue (not exercised by the Node tests) -------------------------------------

function browserIo() {
  const canvas = typeof OffscreenCanvas !== 'undefined' || typeof document !== 'undefined';
  return canvas ? { decode: decodeInBrowser } : null;
}

/** An SVG needs explicit pixel width/height, or Firefox cannot draw it onto a canvas. */
function sizedSvg({ bytes, w, h }) {
  const text = new TextDecoder().decode(bytes).replace(
    /<svg\b[^>]*>/i,
    (tag) => tag.replace(/\s(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')
      .replace(/^<svg\b/i, `<svg width="${w}" height="${h}"`),
  );
  return new Blob([text], { type: 'image/svg+xml' });
}

async function decodeInBrowser(file, svg) {
  let source = null;
  if (!svg && typeof createImageBitmap === 'function') {
    source = await createImageBitmap(file).catch(() => null);
  }
  if (!source) {
    const url = URL.createObjectURL(svg ? sizedSvg(svg) : file);
    try {
      source = new Image();
      source.src = url;
      await source.decode();
    } finally { URL.revokeObjectURL(url); }
  }
  const w = svg ? svg.w : (source.naturalWidth ?? source.width);
  const h = svg ? svg.h : (source.naturalHeight ?? source.height);
  return { w, h, free: () => source.close?.(), encode: makeEncoder(source, w, h, !!svg) };
}

const toBlob = (canvas, type, quality) => (
  canvas.convertToBlob
    ? canvas.convertToBlob({ type, quality }).catch(() => null)
    : new Promise((resolve) => canvas.toBlob(resolve, type, quality))
);

/** encode(side, quality): scale to fit `side`, flatten on white, WebP (JPEG if unsupported). */
function makeEncoder(source, w, h, vector) {
  let last = null;
  return async (side, quality) => {
    const k = vector ? side / Math.max(w, h) : Math.min(1, side / Math.max(w, h));
    const [cw, ch] = [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
    if (last?.cw !== cw || last.ch !== ch) {
      const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(cw, ch)
        : Object.assign(document.createElement('canvas'), { width: cw, height: ch });
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, cw, ch);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(source, 0, 0, cw, ch);
      last = { cw, ch, canvas };
    }
    for (const type of ['image/webp', 'image/jpeg']) { // Safari cannot encode WebP
      const blob = await toBlob(last.canvas, type, quality);
      if (blob?.type === type) return blob;
    }
    return null;
  };
}
