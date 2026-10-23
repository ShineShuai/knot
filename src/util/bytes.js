// Byte helpers: base64url, concat, hashing and a tiny binary writer/reader.
export const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();
export const fromUtf8 = (bytes) => utf8Decoder.decode(bytes);

export function toB64u(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function fromB64u(str) {
  const bin = atob(str.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export const equalBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
export const sha256 = async (bytes) => new Uint8Array(
  await crypto.subtle.digest('SHA-256', bytes),
);

/** Sequential binary writer. Strings and byte blobs are length-prefixed (max 255). */
export class ByteWriter {
  #parts = [];
  u8(n) { this.#parts.push(Uint8Array.of(n)); return this; }
  u16(n) { this.#parts.push(Uint8Array.of(n >> 8, n)); return this; }
  u32(n) { this.#parts.push(Uint8Array.of(n >>> 24, n >>> 16, n >>> 8, n)); return this; }
  raw(bytes) { this.#parts.push(bytes); return this; }
  lp(bytes) {
    if (bytes.length > 255) throw new RangeError('blob longer than 255 bytes');
    return this.u8(bytes.length).raw(bytes);
  }
  str(s) { return this.lp(utf8.encode(s)); }
  done() { return concat(...this.#parts); }
}

/** Sequential binary reader; throws on truncated input. */
export class ByteReader {
  #b; #i = 0;
  constructor(bytes) { this.#b = bytes; }
  get remaining() { return this.#b.length - this.#i; }
  raw(n) {
    if (n > this.remaining) throw new RangeError('truncated data');
    const out = this.#b.subarray(this.#i, this.#i + n);
    this.#i += n;
    return out;
  }
  u8() { return this.raw(1)[0]; }
  u16() { const [a, b] = this.raw(2); return (a << 8) | b; }
  u32() { const [a, b, c, d] = this.raw(4); return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0; }
  lp() { return this.raw(this.u8()); }
  str() { return fromUtf8(this.lp()); }
}
