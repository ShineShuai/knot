// Hand-built image headers for tests (enough for sniffing, not decodable pictures).
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n) => [n & 255, (n >> 8) & 255];
const le24 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
const pad = (n) => Array(n).fill(7);

export const png = (w, h, { animated = false, extra = 0 } = {}) => Uint8Array.from([
  0x89, ...ascii('PNG\r\n\x1a\n'), ...be32(13), ...ascii('IHDR'), ...be32(w), ...be32(h),
  8, 6, 0, 0, 0, 0, 0, 0, 0,
  ...(animated ? [...be32(8), ...ascii('acTL'), 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0] : []),
  ...be32(0), ...ascii('IDAT'), 0, 0, 0, 0, ...pad(extra),
]);

export const jpeg = (w, h, extra = 0) => Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255,
  1, 1, 0x11, 0, ...pad(extra),
]);

export const gif = (w, h, frames = 1) => Uint8Array.from([
  ...ascii('GIF89a'), ...le16(w), ...le16(h), 0, 0, 0,
  ...Array.from({ length: frames }).flatMap(
    () => [0x2c, 0, 0, 0, 0, ...le16(w), ...le16(h), 0, 2, 1, 0, 0],
  ),
  0x3b,
]);

const riff = (chunk, body) => Uint8Array.from([
  ...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), ...ascii(chunk), 10, 0, 0, 0, ...body, ...pad(8),
]);
export const webpX = (w, h, animated = false) => riff(
  'VP8X', [animated ? 2 : 0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)],
);
export const webpL = (w, h) => riff(
  'VP8L', [0x2f, ...le24((w - 1) | ((h - 1) << 14)), ((h - 1) << 14) >>> 24],
);
export const webpLossy = (w, h) => riff(
  'VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h)],
);

export const svg = (attrs = 'viewBox="0 0 40 20"', inner = '<rect width="5" height="5"/>') => (
  new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>`)
);
export const text = (s) => new TextEncoder().encode(s);
