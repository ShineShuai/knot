// The account chain: statements, chain checks, certificates of generation 1 and up, which
// devices a statement keeps, and the budget that bounds the work a stranger's chain can cause.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ChainCache, MAX_KEEP, NO_KEY, VerifyBudget, certGShape, isEnd, isFork, keepHash, makeCertG,
  makeStatement, parseStatement, retiredBy, rootHash, rootRetiredAt, verifyCertG, verifyChain,
} from '../src/crypto/chain.js';
import { identityFromSeed, peerIdOf } from '../src/crypto/identity.js';
import { equalBytes, randomBytes, toB64u } from '../src/util/bytes.js';
import { newIdentity } from './helpers.js';

const key = () => identityFromSeed(randomBytes(32));
const sortKeep = (hashes) => [...hashes].sort((a, b) => {
  for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
});

/** A chain of `plans.length` statements: plans[i] = the devices (public keys) statement i+1
 *  keeps. Resolves to { r, keys: [root, t1, ...], statements: [bytes], parsed chain }. */
async function build(plans, { end = false } = {}) {
  const root = await newIdentity();
  const keys = [root];
  const statements = [];
  let prev = await rootHash(root.pub);
  for (const [i, devices] of plans.entries()) {
    const t = await key();
    const keep = sortKeep(await Promise.all(devices.map(keepHash)));
    const made = await makeStatement(keys[i], {
      r: root.pub, n: i + 1, prev, t: t.pub, ms: 1000 * (i + 1), keep,
    });
    keys.push(t);
    statements.push(made.bytes);
    prev = made.hash;
  }
  if (end) {
    const made = await makeStatement(keys[plans.length], {
      r: root.pub, n: plans.length + 1, prev, ms: 1000 * (plans.length + 1),
    });
    statements.push(made.bytes);
  }
  const verified = await verifyChain(root.pub, statements);
  assert.equal(verified.ok, true, verified.why);
  return { root, keys, statements, chain: verified.chain };
}

const devicePub = async () => (await key()).pub;

test('a statement reads back as it was made and any change to it is caught', async () => {
  const [d1, d2] = [await devicePub(), await devicePub()];
  const { root, statements } = await build([[d1, d2]]);
  const st = parseStatement(statements[0]);
  assert.equal(st.n, 1);
  assert.equal(st.ms, 1000);
  assert.equal(st.keep.length, 2);
  assert.ok(equalBytes(st.r, root.pub));
  assert.equal(isEnd(st), false);
  for (const at of [0, 31, 34, 40, 80, 100, 110, statements[0].length - 1]) {
    const bad = statements[0].slice();
    bad[at] ^= 1;
    const result = await verifyChain(root.pub, [bad]);
    assert.equal(result.ok, false, `byte ${at}`);
  }
  assert.equal(parseStatement(statements[0].subarray(1)), null, 'truncated');
  assert.equal(parseStatement(new Uint8Array([...statements[0], 0])), null, 'trailing byte');
});

test('the chain is checked link by link: numbers, prev, root, order and the end', async () => {
  const { root, keys, statements } = await build([[], [], []]);
  assert.equal((await verifyChain(root.pub, statements)).ok, true);
  assert.equal((await verifyChain(root.pub, [])).ok, true, 'no statement: generation 0');
  assert.equal((await verifyChain(root.pub, [statements[0], statements[2]])).why, 'number');
  assert.equal((await verifyChain(root.pub, [statements[1]])).why, 'number');
  assert.equal((await verifyChain(root.pub, [statements[0], statements[0]])).why, 'number');
  const other = await newIdentity();
  assert.equal((await verifyChain(other.pub, statements)).why, 'root');
  // a statement signed by the wrong key (the root signs n=2 instead of t1)
  const wrong = await makeStatement(root, {
    r: root.pub, n: 2, prev: (await verifyChain(root.pub, [statements[0]])).chain.head,
    t: keys[2].pub, ms: 5,
  });
  const result = await verifyChain(root.pub, [statements[0], wrong.bytes]);
  assert.deepEqual([result.ok, result.why, result.at], [false, 'signature', 2]);
  // prev that names another statement
  const skewed = await makeStatement(keys[1], {
    r: root.pub, n: 2, prev: await rootHash(root.pub), t: keys[2].pub, ms: 5,
  });
  assert.equal((await verifyChain(root.pub, [statements[0], skewed.bytes])).why, 'prev');
});

test('an end statement has no successor key and nothing may follow it', async () => {
  const d = await devicePub();
  const { root, keys, statements, chain } = await build([[d]], { end: true });
  assert.equal(chain.ended, true);
  assert.equal(isEnd(parseStatement(statements[1])), true);
  assert.ok(equalBytes(chain.keys.at(-1), NO_KEY));
  const after = await makeStatement(keys[1], {
    r: root.pub, n: 3, prev: chain.head, t: (await key()).pub, ms: 9,
  });
  assert.equal((await verifyChain(root.pub, [...statements, after.bytes])).why, 'after end');
  assert.deepEqual(await retiredBy(d, 1, chain), { j: 2, ms: 2000 }, 'it drops everyone');
});

test('a keep list is sorted, unique and at most 16', async () => {
  const hashes = await Promise.all(Array.from({ length: 17 }, async () => keepHash(await devicePub())));
  const root = await newIdentity();
  const args = { r: root.pub, n: 1, prev: await rootHash(root.pub), ms: 1 };
  await assert.rejects(makeStatement(root, { ...args, keep: sortKeep(hashes) }), /too many/);
  const ok = sortKeep(hashes).slice(0, MAX_KEEP);
  await makeStatement(root, { ...args, keep: ok });
  await assert.rejects(makeStatement(root, { ...args, keep: [ok[1], ok[0]] }), /sorted/);
  await assert.rejects(makeStatement(root, { ...args, keep: [ok[0], ok[0]] }), /sorted/);
});

test('two statements on one prev are a fork; the same statement twice is not', async () => {
  const root = await newIdentity();
  const prev = await rootHash(root.pub);
  const make = async (ms) => parseStatement((await makeStatement(root, {
    r: root.pub, n: 1, prev, t: (await key()).pub, ms,
  })).bytes);
  const [a, b] = [await make(1), await make(2)];
  assert.equal(await isFork(a, b), true);
  assert.equal(await isFork(a, a), false);
});

test('a certificate of generation k is valid under its chain, and only under it', async () => {
  const [d1, d2] = [await devicePub(), await devicePub()];
  const { root, keys, chain } = await build([[d1], [d1, d2]]);
  const cert = await makeCertG(keys[2], {
    r: root.pub, d: d2, name: 'Pixel', k: 2, h: chain.hashes[1], ms: 5000,
  });
  assert.equal(certGShape(cert), true);
  const got = await verifyCertG(cert, chain);
  assert.deepEqual([got.member, got.k, got.retired], [await peerIdOf(root.pub), 2, null]);
  assert.deepEqual(await verifyCertG(cert, chain), got, 'the same answer twice');
  // the wrong head, the wrong signer, another root, a generation we do not have
  assert.equal(await verifyCertG({ ...cert, g: { k: 2, h: toB64u(chain.hashes[0]) } }, chain), null);
  assert.equal(await verifyCertG({ ...cert, n: 'Other' }, chain), null, 'any field is signed');
  const forged = await makeCertG(keys[1], {
    r: root.pub, d: d2, name: 'Pixel', k: 2, h: chain.hashes[1], ms: 5000,
  });
  assert.equal(await verifyCertG(forged, chain), null, 'signed by the key of generation 1');
  assert.equal(await verifyCertG({ ...cert, r: toB64u((await newIdentity()).pub) }, chain), null);
  assert.equal(await verifyCertG({ ...cert, g: { k: 3, h: cert.g.h } }, chain), null);
  assert.equal(certGShape({ ...cert, extra: 1 }), false);
});

test('a device a later statement does not keep is retired from that statement on', async () => {
  const [kept, lost, newer] = [await devicePub(), await devicePub(), await devicePub()];
  const { root, keys, chain } = await build([[kept, lost], [kept], [kept, newer]]);
  assert.equal(await retiredBy(kept, 0, chain), null, 'generation 0, kept every time');
  assert.deepEqual(await retiredBy(lost, 0, chain), { j: 2, ms: 2000 });
  assert.deepEqual(await retiredBy(lost, 1, chain), { j: 2, ms: 2000 });
  assert.deepEqual(await retiredBy(lost, 2, chain), { j: 3, ms: 3000 }, 'statement 3 drops it too');
  assert.deepEqual(await retiredBy(newer, 1, chain), { j: 2, ms: 2000 }, 'statement 2 never had it');
  assert.equal(await retiredBy(newer, 2, chain), null, 'approved at 2, kept by 3');
  assert.equal(await retiredBy(newer, 3, chain), null, 'nothing after it');
  assert.equal(rootRetiredAt(chain), 1000);
  const cert = await makeCertG(keys[1], {
    r: root.pub, d: lost, name: 'Old', k: 1, h: chain.hashes[0], ms: 1500,
  });
  assert.deepEqual((await verifyCertG(cert, chain)).retired, { j: 2, ms: 2000 });
});

test('retiredBy matches the rule, in random chains', async () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const devices = await Promise.all(Array.from({ length: 5 }, devicePub));
  for (let round = 0; round < 3; round++) {
    const plans = Array.from({ length: 6 }, () => devices.filter(() => rnd(2) === 0));
    const { chain } = await build(plans);
    for (const d of devices) {
      for (let k = 0; k <= 6; k++) {
        let want = null;
        for (let j = k + 1; j <= 6 && !want; j++) if (!plans[j - 1].includes(d)) want = j;
        const got = await retiredBy(d, k, chain);
        assert.equal(got?.j ?? null, want, `round ${round}, generation ${k}`);
      }
    }
  }
});

test('long chains verify, each statement once, and a stranger has a budget', async () => {
  const { root, statements } = await build(Array.from({ length: 40 }, () => []));
  const cache = new ChainCache();
  let t = 0;
  const budget = new VerifyBudget(30, 30, () => t);
  const first = await verifyChain(root.pub, statements, { cache, budget });
  assert.deepEqual([first.ok, first.pending, first.verified], [false, true, 30], 'the budget ran out');
  t += 60_000; // a minute later it has refilled
  const second = await verifyChain(root.pub, statements, { cache, budget });
  assert.equal(second.ok, true, 'the first 30 cost nothing again');
  const again = await verifyChain(root.pub, statements, { cache, budget: new VerifyBudget(1, 1, () => 0) });
  assert.equal(again.ok, true, 'all cached: no budget needed');
});

test('a bad statement in a long chain fails at its place; what came before stays checked', async () => {
  const { root, statements } = await build(Array.from({ length: 12 }, () => []));
  const bad = statements.slice();
  bad[7] = bad[7].slice();
  bad[7][bad[7].length - 1] ^= 1; // the signature of statement 8
  const cache = new ChainCache();
  const result = await verifyChain(root.pub, bad, { cache });
  assert.deepEqual([result.ok, result.why, result.at], [false, 'signature', 8]);
  const good = await verifyChain(root.pub, statements.slice(0, 7), { cache, budget: new VerifyBudget(1, 1, () => 0) });
  assert.equal(good.ok, true, 'the seven before it were remembered');
});
