// The account chain (see the design document, sections 3.2 to 3.5). An account has a root key,
// which is the account's id. A *statement* says "from now on the account key `t` speaks for the
// account"; each is signed by the key before it, so the statements form a chain from the root.
// A device certificate of generation k is signed by the key of statement k and says which device
// key the account approved. A statement lists in `keep` the devices that stay valid; every other
// device approved under an older key is retired. An `end` statement has no successor key: nobody
// speaks for the account after it.
//
// Nothing here knows about rooms. Everything is a pure function of its input, so a room (or a
// test) can run it on whatever arrives, in any order.
import { ByteReader, ByteWriter, concat, equalBytes, fromB64u, sha256, toB64u, utf8 } from '../util/bytes.js';
import { peerIdOf, verifySignature } from './identity.js';

export const MAX_KEEP = 16;
export const NO_KEY = new Uint8Array(32); // the `t` of an `end` statement
const STATEMENT_TAG = utf8.encode('knot/stmt1');
const CERT_TAG = utf8.encode('knot/device2');
const B64U = /^[A-Za-z0-9_-]+$/;
const isB64u = (s, length) => typeof s === 'string' && s.length === length && B64U.test(s);
const MAX_N = 0xffff;

const putU64 = (w, n) => w.u32(Math.floor(n / 2 ** 32)).u32(n >>> 0);
const getU64 = (r) => r.u32() * 2 ** 32 + r.u32();
const compare = (a, b) => { // bytes, lexicographic
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

/** The 16 bytes that stand for a device key in a `keep` list. */
export async function keepHash(devicePub) {
  return (await sha256(devicePub)).subarray(0, 16);
}

/** Does this statement end the chain (no successor key)? */
export const isEnd = (statement) => equalBytes(statement.t, NO_KEY);

/** The hash that statement n=1 names as its `prev`: the hash of the root key. */
export const rootHash = (r) => sha256(r);

const bodyOf = ({ r, n, prev, t, ms, keep }) => {
  const w = new ByteWriter().raw(r).u16(n).raw(prev).raw(t);
  putU64(w, ms).u8(keep.length);
  for (const k of keep) w.raw(k);
  return w.done();
};

/** Make statement `n` of the chain of root `r`, signed by `signer` (an Identity whose key is the
 *  root for n=1, or the key of statement n-1). `keep`: 16-byte hashes (see keepHash), sorted.
 *  Resolves to { bytes, hash }. */
export async function makeStatement(signer, { r, n, prev, t = NO_KEY, ms, keep = [] }) {
  if (keep.length > MAX_KEEP) throw new RangeError('too many kept devices');
  for (let i = 1; i < keep.length; i++) {
    if (compare(keep[i - 1], keep[i]) >= 0) throw new RangeError('keep must be sorted and unique');
  }
  const head = bodyOf({ r, n, prev, t, ms, keep });
  const sig = await signer.sign(concat(STATEMENT_TAG, head));
  const bytes = concat(head, sig);
  return { bytes, hash: await sha256(bytes) };
}

/** Read a statement; null if it is malformed in any way (length, order of `keep`, size). */
export function parseStatement(bytes) {
  try {
    const rd = new ByteReader(bytes);
    const [r, n, prev, t, ms] = [rd.raw(32), rd.u16(), rd.raw(32), rd.raw(32), getU64(rd)];
    const count = rd.u8();
    if (count > MAX_KEEP || n < 1) return null;
    const keep = Array.from({ length: count }, () => rd.raw(16));
    const sig = rd.raw(64);
    if (rd.remaining !== 0) return null;
    for (let i = 1; i < keep.length; i++) if (compare(keep[i - 1], keep[i]) >= 0) return null;
    if (!Number.isSafeInteger(ms)) return null;
    return { r, n, prev, t, ms, keep, sig, head: bytes.subarray(0, bytes.length - 64), bytes };
  } catch {
    return null;
  }
}

/** Two statements that follow the same `prev` but are not the same: a fork. */
export const isFork = async (a, b) => equalBytes(a.prev, b.prev) && a.n === b.n
  && !equalBytes(await sha256(a.bytes), await sha256(b.bytes));

/** Statements already verified, by hash. A statement's hash fixes the statement before it, and
 *  so the key that signed it: a hit is as good as checking again. */
export class ChainCache {
  #max; #seen = new Set();
  constructor(max = 4096) { this.#max = max; }
  has(hash) { return this.#seen.has(toB64u(hash)); }
  add(hash) {
    if (this.#seen.size >= this.#max) this.#seen.delete(this.#seen.values().next().value);
    this.#seen.add(toB64u(hash));
  }
}

/** How many new signatures one peer may make us check per minute: a stranger's made-up chain
 *  burns its own budget and nobody else's. `spend()` is false once it is used up. */
export class VerifyBudget {
  #tokens; #last; #burst; #perMinute; #now;
  constructor(perMinute = 64, burst = perMinute, now = Date.now) {
    [this.#perMinute, this.#burst, this.#now] = [perMinute, burst, now];
    [this.#tokens, this.#last] = [burst, now()];
  }
  spend() {
    const t = this.#now();
    this.#tokens = Math.min(this.#burst, this.#tokens + ((t - this.#last) / 60_000) * this.#perMinute);
    this.#last = t;
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}

/** Check statements (as received, in order) against the root key `r`. Resolves to
 *  { ok: true, chain } or { ok: false, why, at }, or { ok: false, pending: true, verified } when
 *  the budget ran out: ask again later, what was checked is remembered in `cache`. */
export async function verifyChain(r, statements, { cache = null, budget = null } = {}) {
  const fail = (why, at) => ({ ok: false, why, at });
  if (!(r instanceof Uint8Array) || r.length !== 32) return fail('root', 0);
  const chain = { r, statements: [], hashes: [], keys: [r], head: await rootHash(r), ended: false };
  for (const [i, bytes] of statements.entries()) {
    const st = parseStatement(bytes);
    if (!st) return fail('shape', i + 1);
    if (chain.ended) return fail('after end', i + 1);
    if (st.n !== i + 1 || st.n > MAX_N) return fail('number', i + 1);
    if (!equalBytes(st.r, r)) return fail('root', i + 1);
    if (!equalBytes(st.prev, chain.head)) return fail('prev', i + 1);
    const hash = await sha256(bytes);
    if (!cache?.has(hash)) {
      if (budget && !budget.spend()) return { ok: false, pending: true, verified: i };
      const signer = chain.keys[i];
      if (!(await verifySignature(signer, st.sig, concat(STATEMENT_TAG, st.head)))) {
        return fail('signature', i + 1);
      }
      cache?.add(hash);
    }
    chain.statements.push(st);
    chain.hashes.push(hash);
    chain.keys.push(st.t);
    chain.head = hash;
    chain.ended = isEnd(st);
  }
  return { ok: true, chain };
}

/** The first statement after generation `k` that drops the device with this key: { j, ms }, or
 *  null while every later statement keeps it. An `end` statement drops everyone. Generation 0
 *  is a certificate the root key signed itself. */
export async function retiredBy(devicePub, k, chain) {
  const want = await keepHash(devicePub);
  for (let j = k + 1; j <= chain.statements.length; j++) {
    const st = chain.statements[j - 1];
    if (isEnd(st) || !st.keep.some((x) => equalBytes(x, want))) return { j, ms: st.ms };
  }
  return null;
}

/** When the root key itself stopped speaking (statement 1), or null: what it signed directly
 *  with a later stamp does not count. */
export const rootRetiredAt = (chain) => chain.statements[0]?.ms ?? null;

const certBytes = ({ r, d, k, h, name, ms }) => {
  const w = new ByteWriter().raw(CERT_TAG).raw(r).raw(d).u16(k).raw(h).str(name);
  return putU64(w, ms).done();
};

/** A certificate of generation k >= 1: { r, d, n, ms, g: { k, h }, sig }, signed by `signer`,
 *  the Identity of the key of statement k (`h` is the hash of that statement). */
export async function makeCertG(signer, { r, d, name, k, h, ms = Date.now() }) {
  const n = String(name).slice(0, 32);
  const sig = await signer.sign(certBytes({ r, d, k, h, name: n, ms }));
  return { r: toB64u(r), d: toB64u(d), n, ms, g: { k, h: toB64u(h) }, sig: toB64u(sig) };
}

/** Shape only (no signature check): safe to run on anything received. */
export const certGShape = (c) => !!c && typeof c === 'object' && !Array.isArray(c)
  && Object.keys(c).length === 6 && isB64u(c.r, 43) && isB64u(c.d, 43) && isB64u(c.sig, 86)
  && typeof c.n === 'string' && c.n.length <= 32 && Number.isSafeInteger(c.ms) && c.ms >= 0
  && !!c.g && typeof c.g === 'object' && Object.keys(c.g).length === 2
  && Number.isInteger(c.g.k) && c.g.k >= 1 && c.g.k <= MAX_N && isB64u(c.g.h, 43);

const known = new Map(); // (certificate, chain head) -> result

/** What a certificate of generation >= 1 says under a verified chain. Resolves to
 *  { member, k, retired } (`retired`: see retiredBy) or null if it is malformed, names another
 *  root, a statement we do not have, or is not signed by that statement's key. Pure: the same
 *  certificate and chain give the same answer. */
export async function verifyCertG(c, chain) {
  if (!certGShape(c) || c.r !== toB64u(chain.r)) return null;
  const { k } = c.g;
  if (k > chain.statements.length || c.g.h !== toB64u(chain.hashes[k - 1])) return null;
  const key = `${c.r}|${c.d}|${c.n}|${c.ms}|${c.g.k}|${c.g.h}|${c.sig}|${toB64u(chain.head)}`;
  if (known.has(key)) return known.get(key);
  const signer = chain.keys[k];
  const d = fromB64u(c.d);
  const ok = !equalBytes(signer, NO_KEY) && await verifySignature(
    signer, fromB64u(c.sig), certBytes({ r: chain.r, d, k, h: chain.hashes[k - 1], name: c.n, ms: c.ms }),
  );
  const result = ok ? { member: await peerIdOf(chain.r), k, retired: await retiredBy(d, k, chain) } : null;
  if (known.size > 256) known.clear();
  known.set(key, result);
  return result;
}
