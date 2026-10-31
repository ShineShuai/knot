import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { forceSoftCurves, hasNative, softNacl } from '../src/crypto/curves.js';
import { identityFromSeed, loadIdentity, verifySignature } from '../src/crypto/identity.js';
import { newBoxKey, openBox, sealBox } from '../src/crypto/box.js';
import { MemoryKV } from '../src/store/kv.js';
import { fromB64u, randomBytes, toB64u, utf8 } from '../src/util/bytes.js';

const hex = (s) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
// Restore what the process started with (`npm run test:soft` preloads the forced mode).
const startedSoft = !(await hasNative('Ed25519'));
afterEach(() => forceSoftCurves(startedSoft));

const soft = async (fn) => { forceSoftCurves(true); return fn(); };
const native = async (fn) => {
  forceSoftCurves(false);
  assert.ok(await hasNative('Ed25519'), 'this test needs WebCrypto Ed25519 (Node 20+)');
  return fn();
};

test('Ed25519 without WebCrypto: RFC 8032 test 1 and 3', async () => {
  const vectors = [
    ['9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', '',
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9'
      + 'b46bd25bf5f0595bbe24655141438e7a100b'],
    ['c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7', 'af82',
      '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984d'
      + 'c6594a7c15e9716ed28dc027beceea1ec40a'],
  ];
  await soft(async () => {
    for (const [seed, msg, sig] of vectors) {
      const id = await identityFromSeed(hex(seed));
      assert.deepEqual(await id.sign(hex(msg)), hex(sig));
      assert.ok(await verifySignature(id.pub, hex(sig), hex(msg)));
      assert.ok(!(await verifySignature(id.pub, hex(sig), hex(`${msg}00`))));
    }
  });
});

test('X25519 without WebCrypto: RFC 7748 section 6.1', async () => {
  const [alice, alicePub, bobPub, shared] = [
    '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a',
    '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a',
    'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f',
    '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742',
  ].map(hex);
  const nacl = await softNacl();
  assert.deepEqual(nacl.scalarMult.base(alice), alicePub);
  assert.deepEqual(nacl.scalarMult(alice, bobPub), shared);
});

test('soft and native Ed25519 give identical keys and signatures', async () => {
  for (let i = 0; i < 5; i++) {
    const seed = randomBytes(32);
    const data = randomBytes(1 + i * 37);
    const [a, b] = [
      await soft(() => identityFromSeed(seed)), await native(() => identityFromSeed(seed)),
    ];
    assert.equal(a.id, b.id);
    assert.deepEqual(a.pub, b.pub);
    const sig = await a.sign(data);
    assert.deepEqual(sig, await b.sign(data)); // Ed25519 is deterministic
    assert.ok(await native(() => verifySignature(a.pub, sig, data)));
    assert.ok(await soft(() => verifySignature(a.pub, sig, data)));
    assert.ok(!(await soft(() => verifySignature(a.pub, sig, randomBytes(8)))));
  }
});

test('soft verification refuses a signature with S + L, as WebCrypto does', async () => {
  const id = await soft(() => identityFromSeed(randomBytes(32)));
  const data = utf8.encode('hello');
  const sig = await soft(() => id.sign(data));
  const L = (1n << 252n) + 27742317777372353535851937790883648493n;
  let s = 0n;
  for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(sig[i]);
  const twin = Uint8Array.from(sig);
  let t = s + L;
  for (let i = 32; i < 64; i++, t >>= 8n) twin[i] = Number(t & 0xffn);
  assert.ok(await soft(() => verifySignature(id.pub, sig, data)));
  assert.ok(!(await soft(() => verifySignature(id.pub, twin, data))));
  assert.ok(!(await soft(() => verifySignature(id.pub, sig.subarray(0, 63), data))));
  assert.ok(!(await soft(() => verifySignature(id.pub.subarray(0, 31), sig, data))));
});

test('sealed boxes open across soft and native, both ways', async () => {
  const aad = utf8.encode('ctx');
  for (const [mine, theirs] of [[soft, native], [native, soft]]) {
    const recipient = await mine(() => newBoxKey());
    const sealed = await theirs(() => sealBox(recipient.pub, utf8.encode('secret'), aad));
    const plain = await mine(() => openBox(recipient.privateKey, sealed, aad));
    assert.equal(new TextDecoder().decode(plain), 'secret');
    await assert.rejects(mine(() => openBox(recipient.privateKey, sealed, utf8.encode('x'))));
  }
});

test('soft box refuses an all-zero (weak) public key', async () => {
  const key = await soft(() => newBoxKey());
  const bad = new Uint8Array(32 + 12 + 16 + 4); // ephemeral key = 0
  await assert.rejects(soft(() => openBox(key.privateKey, bad, utf8.encode('c'))), /Weak/);
});

test('soft identity is stored as a seed and comes back as the same identity', async () => {
  await soft(async () => {
    const kv = new MemoryKV();
    const first = await loadIdentity(kv);
    assert.equal((await kv.get('identity')).seed.length, 32);
    assert.equal((await loadIdentity(kv)).id, first.id);
    const sig = await first.sign(utf8.encode('m'));
    assert.ok(await verifySignature(first.pub, sig, utf8.encode('m')));
    assert.equal(toB64u(fromB64u(first.id)), first.id);
  });
  // The same browser later gains WebCrypto (an iOS update): the identity stays.
  await native(async () => {
    const kv = new MemoryKV();
    await soft(() => loadIdentity(kv));
    const before = await soft(() => loadIdentity(kv));
    assert.equal((await loadIdentity(kv)).id, before.id);
  });
});
