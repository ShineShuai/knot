// Turns the http(s) links in a message into real links. Everything else stays plain text.
// Only plain-ASCII addresses are linked: no look-alike letters, no hidden direction marks.
import { h } from './dom.js';

const MAX_URL = 2000;
const CANDIDATE = /https?:\/\/[\x21-\x7e]+/gi; // printable ASCII, up to the next space
const TRAILING = /[.,;:!?'"*]$/;
const BRACKETS = { ')': '(', ']': '[', '}': '{' };
const NOT_IN_URL = /[<>"`\\^|]/; // cannot belong to a link: the link stops just before

/** Drop what usually follows a link in a sentence: `.`, `,`, a closing bracket without an
 *  opening one inside the link, and so on. */
function trimEnd(url) {
  let end = url.length;
  for (;;) {
    const last = url[end - 1];
    const open = BRACKETS[last];
    const count = (ch) => [...url.slice(0, end)].filter((c) => c === ch).length;
    if (TRAILING.test(last ?? '') || (open && count(last) > count(open))) end--;
    else return url.slice(0, end);
  }
}

/** The address a candidate stands for, or null if it is not a safe web link. */
function webAddress(text) {
  if (text.length > MAX_URL) return null;
  let url;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null; // https://bank.com@evil.test looks like bank.com
  const host = url.hostname;
  return host.includes('.') || host === 'localhost' || host.startsWith('[') ? url.href : null;
}

/** `text` as pieces: `{ text }` for plain text, `{ text, href }` for a link. Joined, the
 *  `text` of all pieces is the original. */
export function splitLinks(text) {
  const pieces = [];
  let from = 0;
  const plain = (to) => { if (to > from) pieces.push({ text: text.slice(from, to) }); };
  for (const match of text.matchAll(CANDIDATE)) {
    const stop = match[0].search(NOT_IN_URL);
    const shown = trimEnd(stop < 0 ? match[0] : match[0].slice(0, stop));
    const href = webAddress(shown);
    if (!href) continue;
    plain(match.index);
    pieces.push({ text: shown, href });
    from = match.index + shown.length;
  }
  plain(text.length);
  return pieces;
}

/** Nodes for `h(...)`: strings and `<a>` elements. A link opens in a new tab and never
 *  gets the opener or the referrer; hovering shows the real address. */
export const linkify = (text) => splitLinks(text).map((piece) => (piece.href ? h('a', {
  class: 'link', href: piece.href, target: '_blank', rel: 'noopener noreferrer nofollow',
  title: piece.href,
}, piece.text) : piece.text));
