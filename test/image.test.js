import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS, asImage, deriveImage, pixelsOk, sniffImage, thumbBlob,
} from '../src/files/image.js';
import { toB64u } from '../src/util/bytes.js';
import { gif, jpeg, png, svg, text, webpL, webpLossy, webpX } from './images.js';

test('sniffImage reads type and size from headers', () => {
  assert.deepEqual(sniffImage(png(300, 200)), { type: 'image/png', w: 300, h: 200 });
  assert.deepEqual(sniffImage(jpeg(4032, 3024, 20)), { type: 'image/jpeg', w: 4032, h: 3024 });
  assert.deepEqual(sniffImage(gif(64, 48)), { type: 'image/gif', w: 64, h: 48 });
  assert.deepEqual(sniffImage(webpX(800, 600)), { type: 'image/webp', w: 800, h: 600 });
  assert.deepEqual(sniffImage(webpL(321, 123)), { type: 'image/webp', w: 321, h: 123 });
  assert.deepEqual(sniffImage(webpLossy(640, 480)), { type: 'image/webp', w: 640, h: 480 });
  assert.equal(sniffImage(text('hello world, not an image')), null);
  assert.equal(sniffImage(png(1, 1).subarray(0, 12)), null);
  assert.equal(sniffImage(jpeg(10, 10).subarray(0, 8)), null);
});

test('pixelsOk stops decompression bombs before any decode', () => {
  assert.equal(pixelsOk(sniffImage(png(4096, 4096))), true);
  assert.equal(pixelsOk(sniffImage(png(40000, 40000))), false);
  assert.equal(pixelsOk(sniffImage(png(0, 10))), false);
  assert.equal(pixelsOk(sniffImage(png(8000, 8000)), LIMITS.originalPixels), true);
});

test('SVG: sized from width/height or viewBox, only accepted whole and without script', () => {
  assert.deepEqual(sniffImage(svg('viewBox="0 0 40 20"')), svgInfo(40, 20));
  assert.deepEqual(sniffImage(svg('width="120" height="80px"')), svgInfo(120, 80));
  assert.deepEqual(
    sniffImage(svg('width="100%" height="100%" viewBox="0 0 30 10"')),
    svgInfo(30, 10),
  );
  assert.equal(sniffImage(svg('')).w, 0); // no intrinsic size
  const prolog = text('\ufeff<?xml version="1.0"?>\n<!-- c -->\n<!DOCTYPE svg PUBLIC "a" "b">\n'
    + '<svg viewBox="0 0 2 2"></svg>');
  assert.equal(sniffImage(prolog).type, 'image/svg+xml');
  assert.equal(sniffImage(svg('viewBox="0 0 1 1"', '<script>alert(1)</script>')), null);
  assert.equal(sniffImage(svg('viewBox="0 0 1 1"', '<SCRIPT src=x></SCRIPT>')), null);
  const bomb = text('<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg viewBox="0 0 1 1">&a;</svg>');
  assert.equal(sniffImage(bomb), null);
  assert.equal(sniffImage(text('<html><svg viewBox="0 0 1 1"></svg></html>')), null);
  assert.equal(sniffImage(text('<svg')), null);
  const whole = svg();
  assert.equal(sniffImage(whole.subarray(0, 30), whole.length), null); // a prefix is not trusted
  assert.equal(sniffImage(new Uint8Array(LIMITS.svgMax + 1).fill(32)), null);
});

test('asImage re-types by content and refuses everything else', async () => {
  const typed = await asImage(new Blob([png(10, 10)], { type: 'application/octet-stream' }));
  assert.equal(typed.type, 'image/png');
  assert.equal((await asImage(new Blob([svg()], { type: '' }))).type, 'image/svg+xml');
  assert.equal(await asImage(new Blob([text('<html></html>')], { type: 'image/png' })), null);
  assert.equal(await asImage(new Blob([png(30000, 30000)])), null);
});

test('thumbBlob validates the inline thumbnail', () => {
  const ok = { t: toB64u(png(160, 90)), tm: 'image/png' };
  assert.equal(thumbBlob(ok).type, 'image/png');
  assert.equal(thumbBlob({ ...ok, tm: 'image/webp' }), null); // claimed type must match
  assert.equal(thumbBlob({ t: toB64u(text('not an image')), tm: 'image/png' }), null);
  assert.equal(thumbBlob({ t: '***', tm: 'image/png' }), null);
  const fat = toB64u(png(160, 90, { extra: LIMITS.thumbMax }));
  assert.equal(thumbBlob({ t: fat, tm: 'image/png' }), null);
});

// A stand-in for the browser: bigger side and higher quality make bigger output.
const fakeIo = ({ w, h, factor = 0.25, vector = false, log = [] }) => ({
  decode: async () => ({
    w,
    h,
    free: () => log.push('free'),
    encode: async (side, q) => {
      log.push([side, q]);
      const k = vector ? side / Math.max(w, h) : Math.min(1, side / Math.max(w, h));
      const size = Math.round(w * k * h * k * q * factor);
      return new Blob([new Uint8Array(size)], { type: 'image/webp' });
    },
  }),
});
const run = (bytes, type, io) => deriveImage(new File([bytes], 'f', { type }), bytes, io);
const svgInfo = (w, h) => ({ type: 'image/svg+xml', w, h });

test('deriveImage: thumbnail within budget, big originals also get a preview', async () => {
  const bytes = png(3000, 2000, { extra: 400_000 });
  const log = [];
  const io = fakeIo({ w: 3000, h: 2000, log });
  const out = await run(bytes, 'image/png', io);
  assert.equal(out.img.w, 3000);
  assert.equal(out.img.h, 2000);
  assert.equal(out.img.tm, 'image/webp');
  assert.ok(out.img.t.length * 0.75 <= LIMITS.thumbTarget);
  assert.ok(out.preview.size <= LIMITS.previewMax);
  assert.equal(out.preview.type, 'image/webp');
  assert.equal(out.img.a, undefined);
  assert.equal(log.at(-1), 'free');
});

test('deriveImage steps down quality and size until the thumbnail fits', async () => {
  const bytes = png(1600, 1200, { extra: 400_000 });
  const log = [];
  const io = fakeIo({ w: 1600, h: 1200, factor: 1, log });
  const out = await run(bytes, 'image/png', io);
  const thumbTries = log.filter((x) => Array.isArray(x) && x[0] <= 160);
  assert.ok(thumbTries.length > 1);
  assert.ok(out.img.t.length * 0.75 <= LIMITS.thumbTarget);
});

test('a small original is its own preview (no second rendition)', async () => {
  const bytes = png(300, 200, { extra: 5000 });
  const out = await run(bytes, 'image/png', fakeIo({ w: 300, h: 200 }));
  assert.equal(out.preview, null);
  assert.ok(out.img.t);
});

test('animated GIF / APNG / WebP are flagged', async () => {
  for (const bytes of [gif(40, 40, 3), png(40, 40, { animated: true }), webpX(40, 40, true)]) {
    const out = await run(bytes, 'image/x', fakeIo({ w: 40, h: 40 }));
    assert.equal(out.img.a, 1);
  }
  const still = gif(40, 40, 1);
  assert.equal((await run(still, 'image/gif', fakeIo({ w: 40, h: 40 }))).img.a, undefined);
});

test('formats we cannot sniff are decoded by the browser if it claims them', async () => {
  const bytes = text('....ftypavif....'.repeat(100));
  const out = await run(bytes, 'image/avif', fakeIo({ w: 800, h: 600 }));
  assert.ok(out.img.t);
  assert.ok(out.preview); // not sniffable, so never its own preview
  assert.equal(await run(bytes, 'application/octet-stream', fakeIo({ w: 8, h: 8 })), null);
});

test('SVG: tiny ones are their own crisp thumbnail, big ones are rasterised', async () => {
  const tiny = svg('viewBox="0 0 40 20"');
  const a = await run(tiny, 'image/svg+xml', fakeIo({ w: 40, h: 20 }));
  assert.equal(a.img.tm, 'image/svg+xml');
  assert.equal(a.preview, null); // small, so the SVG itself is the preview
  const big = svg('viewBox="0 0 4000 3000"', '<!-- -->'.repeat(60_000));
  assert.ok(big.length > LIMITS.ownPreviewMax && big.length < LIMITS.svgMax);
  const log = [];
  const b = await run(big, 'image/svg+xml', fakeIo({ w: 4000, h: 3000, vector: true, log }));
  assert.equal(b.img.tm, 'image/webp');
  assert.ok(b.preview.size <= LIMITS.previewMax);
  const noSize = svg('');
  assert.equal(await run(noSize, 'image/svg+xml', fakeIo({ w: 1, h: 1 })), null);
});

test('deriveImage gives up cleanly: non-images, bombs, and Node without a canvas', async () => {
  const txt = text('plain text');
  assert.equal(await run(txt, 'text/plain', fakeIo({ w: 1, h: 1 })), null);
  const bomb = png(40000, 40000);
  assert.equal(await run(bomb, 'image/png', fakeIo({ w: 1, h: 1 })), null);
  const ok = png(10, 10);
  assert.equal(await run(ok, 'image/png'), null); // no browser io in Node
});
