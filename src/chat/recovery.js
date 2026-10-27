// The owner's recovery code: everything needed to take a room back on a new device after the
// owner's identity is lost, written as one string to keep offline.
//   knot-rk1-<base64url of: room secret 16 | founder id 8 | recovery seed 32 | [epoch n 2 |
//   epoch secret 16] | crc32 4>
// The seed stands for the recovery key whose public half is registered in the room's chain.
// Whoever holds the code can take the room over: it is as sensitive as a password.
import { concat, fromB64u, toB64u } from '../util/bytes.js';

const PREFIX = 'knot-rk1-';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ((crc ^ 0xffffffff) >>> 0);
}
const u32 = (n) => Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);

/** `epoch`: { n, secret: Uint8Array } or null. `founder`: peer id of the room's creator. */
export function encodeRecoveryCode({ secret, founder, seed, epoch = null }) {
  const parts = [secret, fromB64u(founder), seed];
  if (epoch) parts.push(Uint8Array.of(epoch.n >> 8, epoch.n & 255), epoch.secret);
  const body = concat(...parts);
  return PREFIX + toB64u(concat(body, u32(crc32(body))));
}

/** Throws a readable error for anything that is not an intact code. */
export function decodeRecoveryCode(text) {
  const raw = text.trim().replace(/\s+/g, '');
  if (!raw.startsWith(PREFIX)) throw new Error('This is not a recovery code');
  let bytes;
  try { bytes = fromB64u(raw.slice(PREFIX.length)); } catch { bytes = new Uint8Array(); }
  const body = bytes.subarray(0, -4);
  const sum = bytes.subarray(-4);
  const intact = body.length > 0 && u32(crc32(body)).every((b, i) => b === sum[i]);
  if (!intact || ![56, 74].includes(body.length)) throw new Error('The recovery code is damaged');
  const epoch = body.length === 74
    ? { n: (body[56] << 8) | body[57], secret: body.slice(58, 74) } : null;
  return {
    secret: body.slice(0, 16), founder: toB64u(body.slice(16, 24)), seed: body.slice(24, 56), epoch,
  };
}
