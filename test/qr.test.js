import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { byteCapacity, encodeQr, qrPath } from '../src/qr/qr.js';

test('byte capacities match the QR specification table (L and M, versions 1-10)', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((v) => byteCapacity(v, 'L')),
    [17, 32, 53, 78, 106, 134, 154, 192, 230, 271],
  );
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((v) => byteCapacity(v, 'M')),
    [14, 26, 42, 62, 84, 106, 122, 152, 180, 213],
  );
  assert.equal(byteCapacity(40, 'L'), 2953);
  assert.equal(byteCapacity(40, 'M'), 2331);
});

test('encodeQr picks the smallest version and rejects oversize input', () => {
  assert.equal(encodeQr('x'.repeat(17)).version, 1);
  assert.equal(encodeQr('x'.repeat(18)).version, 2);
  assert.throws(() => encodeQr('x'.repeat(3000)), RangeError);
  assert.match(qrPath(encodeQr('hi')), /^M\d+ \d+h\d+v1h-\d+z/);
});

// Independent check: render to a PGM image and decode it with OpenCV.
function decodeWithOpenCv(qr) {
  const scale = 8, border = 4, n = (qr.size + 2 * border) * scale;
  const px = Buffer.alloc(n * n, 255);
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) {
    if (!qr.modules[y][x]) continue;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) px[((y +
      border) * scale + dy) * n + (x + border) * scale + dx] = 0;
  }
  const file = join(mkdtempSync(join(tmpdir(), 'qr-')), 'q.pgm');
  writeFileSync(file, Buffer.concat([Buffer.from(`P5\n${n} ${n}\n255\n`), px]));
  const script = [
    'import cv2,sys',
    't,_,_=cv2.QRCodeDetector().detectAndDecode(cv2.imread(sys.argv[1]))',
    'sys.stdout.write(t)',
  ].join(';');
  return execFileSync('python3', ['-c', script, file], { encoding: 'utf8' });
}

let haveOpenCv = true;
try {
  execFileSync('python3', ['-c', 'import cv2'], { stdio: 'ignore' });
} catch { haveOpenCv = false; }

const CASES = [[10, 'L'], [60, 'M'], [150, 'L'], [270, 'L'], [320, 'L'], [400, 'M'], [700, 'L']];
for (const [len, level] of CASES) {
  test(`QR of ${len} chars at level ${level} decodes with OpenCV`, { skip: !haveOpenCv &&
    'OpenCV not installed' }, () => {
    const text = Array.from(
      { length: len },
      (_, i) => 'knot1-AZaz09_-'[(i * 7 + (i >> 3)) % 14],
    ).join('');
    const qr = encodeQr(text, level);
    assert.equal(decodeWithOpenCv(qr), text, `version ${qr.version}`);
  });
}
