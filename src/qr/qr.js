// QR Code encoder (byte mode, error correction L or M, versions 1-40).
// Follows the structure of Project Nayuki's reference implementation.
// encodeQr(text) -> { size, modules: boolean[][] }   (true = dark)
import { utf8 } from '../util/bytes.js';

// Index = version (1..40). Rows: ECC level L, M.
const ECC_CODEWORDS_PER_BLOCK = [
  [
    -1,
    7,
    10,
    15,
    20,
    26,
    18,
    20,
    24,
    30,
    18,
    20,
    24,
    26,
    30,
    22,
    24,
    28,
    30,
    28,
    28,
    28,
    28,
    30,
    30,
    26,
    28,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
  ],
  [
    -1,
    10,
    16,
    26,
    18,
    24,
    16,
    18,
    22,
    22,
    26,
    30,
    22,
    22,
    24,
    24,
    28,
    28,
    26,
    26,
    26,
    26,
    28,
    28,
    28,
    28,
    28,
    28,
    28,
    28,
    28,
    28,
    28,
    28,
    28,
    28,
    28,
    28,
    28,
    28,
    28,
  ],
];
const NUM_ERROR_CORRECTION_BLOCKS = [
  [
    -1,
    1,
    1,
    1,
    1,
    1,
    2,
    2,
    2,
    2,
    4,
    4,
    4,
    4,
    4,
    6,
    6,
    6,
    6,
    7,
    8,
    8,
    9,
    9,
    10,
    12,
    12,
    12,
    13,
    14,
    15,
    16,
    17,
    18,
    19,
    19,
    20,
    21,
    22,
    24,
    25,
  ],
  [
    -1,
    1,
    1,
    1,
    2,
    2,
    4,
    4,
    4,
    5,
    5,
    5,
    8,
    9,
    9,
    10,
    10,
    11,
    13,
    14,
    16,
    17,
    17,
    18,
    20,
    21,
    23,
    25,
    26,
    28,
    29,
    31,
    33,
    35,
    37,
    38,
    40,
    43,
    45,
    47,
    49,
  ],
];
const LEVELS = { L: { row: 0, formatBits: 1 }, M: { row: 1, formatBits: 0 } };

const rawDataModules = (ver) => {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
};
const dataCodewords = (ver, lvl) =>
  Math.floor(
    rawDataModules(ver) / 8,
  ) - ECC_CODEWORDS_PER_BLOCK[lvl.row][ver] * NUM_ERROR_CORRECTION_BLOCKS[lvl.row][ver];

/** Maximum payload bytes (byte mode) for a version and level. */
export const byteCapacity = (ver, level = 'L') =>
  Math.floor((dataCodewords(ver, LEVELS[level]) * 8 - 4 - (ver < 10 ? 8 : 16)) / 8);

// ---- Reed-Solomon over GF(256), polynomial 0x11D -------------------------------
const gfMul = (x, y) => {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
  return z;
};
function rsDivisor(degree) {
  const result = Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 2);
  }
  return result;
}
function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
  }
  return result;
}

// ---- codeword assembly ----------------------------------------------------------------
function makeDataCodewords(bytes, ver, lvl) {
  const bits = [];
  const put = (value, n) => { for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, ver < 10 ? 8 : 16);
  bytes.forEach((b) => put(b, 8));
  const capBits = dataCodewords(ver, lvl) * 8;
  put(0, Math.min(4, capBits - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; out.length < capBits / 8; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

function addEccAndInterleave(data, ver, lvl) {
  const blocksCount = NUM_ERROR_CORRECTION_BLOCKS[lvl.row][ver];
  const eccLen = ECC_CODEWORDS_PER_BLOCK[lvl.row][ver];
  const raw = Math.floor(rawDataModules(ver) / 8);
  const shortBlocks = blocksCount - (raw % blocksCount);
  const shortLen = Math.floor(raw / blocksCount);
  const divisor = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < blocksCount; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < shortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const out = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach(
      (block, j) => { if (i !== shortLen - eccLen || j >= shortBlocks) out.push(block[i]); },
    );
  }
  return out;
}

// ---- matrix drawing ------------------------------------------------------------------------
class Matrix {
  constructor(ver) {
    this.ver = ver;
    this.size = ver * 4 + 17;
    this.dark = Array.from({ length: this.size }, () => Array(this.size).fill(false));
    this.fixed = Array.from({ length: this.size }, () => Array(this.size).fill(false));
  }
  set(x, y, v) { this.dark[y][x] = v; this.fixed[y][x] = true; }

  drawFunctionPatterns(formatBits) {
    const { size, ver } = this;
    for (let i = 0; i < size; i++) { this.set(6, i, i % 2 === 0); this.set(i, 6, i % 2 === 0); }
    for (const [x, y] of [[3, 3], [size - 4, 3], [3, size - 4]]) this.#finder(x, y);
    const pos = this.#alignmentPositions();
    pos.forEach((px, i) => pos.forEach((py, j) => {
      const corner = (i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (
        i === pos.length - 1 && j === 0
      );
      if (!corner) this.#alignment(px, py);
    }));
    this.drawFormat(formatBits, 0);
    this.#version(ver);
  }
  #finder(x, y) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      const [xx, yy] = [x + dx, y + dy];
      if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.set(
        xx,
        yy,
        d !== 2 && d !== 4,
      );
    }
  }
  #alignment(x, y) {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(
      x + dx,
      y + dy,
      Math.max(Math.abs(dx), Math.abs(dy)) !== 1,
    );
  }
  #alignmentPositions() {
    const { ver, size } = this;
    if (ver === 1) return [];
    const n = Math.floor(ver / 7) + 2;
    const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    const out = [6];
    for (let pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
    return out;
  }
  drawFormat(eccFormatBits, mask) {
    const { size } = this;
    const data = (eccFormatBits << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6)); this.set(8, 8, bit(7)); this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, size - 15 + i, bit(i));
    this.set(8, size - 8, true);
  }
  #version(ver) {
    if (ver < 7) return;
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const v = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3), b = Math.floor(i / 3);
      this.set(a, b, v); this.set(b, a, v);
    }
  }
  drawCodewords(data) {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? this.size - 1 - vert : vert;
        if (!this.fixed[y][x] && i < data.length * 8) {
          this.dark[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }
  applyMask(mask) {
    const tests = [
      (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (
        x + y
      ) % 3 === 0,
      (x, y) => (
        Math.floor(x / 3) + Math.floor(y / 2)
      ) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
      (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (
        ((x + y) % 2) + ((x * y) % 3)
      ) % 2 === 0,
    ];
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) {
      if (!this.fixed[y][x] && tests[mask](x, y)) this.dark[y][x] = !this.dark[y][x];
    }
  }

  /** Penalty per the QR spec: long runs, 2x2 blocks, finder-like patterns, dark/light balance. */
  penalty() {
    const { size, dark } = this;
    let score = 0;
    const lines = [...dark, ...Array.from({ length: size }, (_, x) => dark.map((row) => row[x]))];
    for (const line of lines) {
      let run = 1;
      for (let i = 1; i <= size; i++) {
        if (i < size && line[i] === line[i - 1]) run++;
        else { if (run >= 5) score += run - 2; run = 1; }
      }
      const s = line.map((v) => (v ? '1' : '0')).join('');
      for (const pattern of ['10111010000', '00001011101']) {
        for (let at = s.indexOf(pattern); at >= 0; at = s.indexOf(pattern, at + 1)) score += 40;
      }
    }
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const v = dark[y][x];
        if (v === dark[y][x + 1] && v === dark[y + 1][x] && v === dark[y + 1][x + 1]) score += 3;
      }
    }
    const total = size * size;
    const darkCount = dark.flat().filter(Boolean).length;
    return score + (Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * 10;
  }
}

/** Encode text as UTF-8 bytes in the smallest version that fits. */
export function encodeQr(text, level = 'L') {
  const lvl = LEVELS[level];
  const bytes = utf8.encode(text);
  let ver = 1;
  while (ver <= 40 && byteCapacity(ver, level) < bytes.length) ver++;
  if (ver > 40) throw new RangeError('Text too long for a QR code');

  const codewords = addEccAndInterleave(makeDataCodewords([...bytes], ver, lvl), ver, lvl);
  const m = new Matrix(ver);
  m.drawFunctionPatterns(lvl.formatBits);
  m.drawCodewords(codewords);

  let best = 0, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    m.applyMask(mask);
    m.drawFormat(lvl.formatBits, mask);
    const score = m.penalty();
    if (score < bestScore) { best = mask; bestScore = score; }
    m.applyMask(mask); // undo
  }
  m.applyMask(best);
  m.drawFormat(lvl.formatBits, best);
  return { size: m.size, version: ver, modules: m.dark };
}

/** SVG path data ("M x y h w v1 h-w z" per horizontal run of dark modules). */
export function qrPath({ size, modules }, border = 4) {
  let d = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!modules[y][x]) continue;
      let w = 1;
      while (x + w < size && modules[y][x + w]) w++;
      d += `M${x + border} ${y + border}h${w}v1h-${w}z`;
      x += w;
    }
  }
  return d;
}
