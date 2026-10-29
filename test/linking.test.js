// Linked devices: certificates, the two-code exchange, and what a certificate means for envelopes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ByteWriter, fromB64u, randomBytes, toB64u } from '../src/util/bytes.js';
import { applyDelegation, certShape, makeCert, verifyCert } from '../src/crypto/delegation.js';
import { newBoxKey, sealBox } from '../src/crypto/box.js';
import {
  linkCode, makeLinkGrant, makeLinkRequest, readLinkGrant, readLinkRequest,
} from '../src/chat/devices.js';
import { authorIdOf, createEnvelope, unlinkBody, verifyEnvelope } from '../src/chat/envelope.js';
import { HLC } from '../src/util/hlc.js';
import { MemoryKV } from '../src/store/kv.js';
import { newIdentity } from './helpers.js';
import { linkIdentity } from './room-kit.js';

const rooms = () => [
  { secret: toB64u(randomBytes(16)), label: 'Club', founder: null, epoch: null },
  {
    secret: toB64u(randomBytes(16)), label: 'Two', founder: 'abcdefghijk',
    epoch: { n: 2, s: toB64u(randomBytes(16)) },
  },
];

test('a certificate names exactly one device key and cannot be altered', async () => {
  const [main, phone, other] = [await newIdentity(), await newIdentity(), await newIdentity()];
  const cert = await makeCert(main, phone.pub, 'Pixel');
  assert.equal(certShape(cert), true);
  assert.equal(await verifyCert(cert), main.id);
  for (const change of [
    { d: toB64u(other.pub) }, { n: 'Mallory' }, { ms: cert.ms + 1 }, { r: toB64u(other.pub) },
    { sig: toB64u(randomBytes(64)) },
  ]) {
    assert.equal(await verifyCert({ ...cert, ...change }), null, Object.keys(change)[0]);
  }
  for (const junk of [null, 'x', {}, { ...cert, sig: 'short' }, { ...cert, n: 'x'.repeat(33) }]) {
    assert.equal(await verifyCert(junk), null);
  }
});

test('a device uses its stored certificate only if it is for its own key', async () => {
  const [main, phone, other] = [await newIdentity(), await newIdentity(), await newIdentity()];
  const kv = new MemoryKV();
  const plain = await applyDelegation(phone, kv);
  assert.equal(plain.member, phone.id, 'nothing stored: a main device');
  await kv.put('delegate', { cert: await makeCert(main, other.pub, 'Other') });
  assert.equal((await applyDelegation(phone, kv)).cert, null, 'a certificate for another key');
  await kv.put('delegate', { cert: await makeCert(main, phone.pub, 'Pixel') });
  const linked = await applyDelegation(phone, kv);
  assert.equal(linked.member, main.id);
  assert.equal(linked.id, phone.id, 'the key keeps its own id');
});

test('two codes link a device: rooms arrive sealed, screens show the same digits', async () => {
  const [main, phone] = [await newIdentity(), await newIdentity()];
  const box = await newBoxKey();
  const requestCode = await makeLinkRequest(phone, { name: 'Pixel', boxPub: box.pub });
  const request = await readLinkRequest(`please link: ${requestCode} thanks`);
  assert.equal(request.id, phone.id);
  assert.equal(request.name, 'Pixel');
  const list = rooms();
  const grant = await makeLinkGrant(main, request, { name: 'Ada', rooms: list });
  assert.match(grant.sas, /^\d{3} \d{3}$/);
  const read = await readLinkGrant(
    `code: ${grant.code}`, { identity: phone, boxKey: box, boxPub: box.pub },
  );
  assert.equal(read.mainId, main.id);
  assert.equal(read.name, 'Ada');
  assert.deepEqual(read.rooms, list);
  assert.equal(read.sas, grant.sas);
  assert.equal(await verifyCert(read.cert), main.id);
  assert.equal(read.cert.d, toB64u(phone.pub));
  assert.equal(await linkCode(phone.pub, main.pub, box.pub), grant.sas);
  assert.ok(!grant.code.includes(list[0].secret), 'room secrets are not readable in the code');
});

test('a request must be genuine, recent and well-formed', async () => {
  const phone = await newIdentity();
  const box = await newBoxKey();
  const code = await makeLinkRequest(phone, { name: 'Pixel', boxPub: box.pub, now: 1_000_000 });
  assert.ok(await readLinkRequest(code, 1_000_000 + 60_000));
  assert.equal(await readLinkRequest(code, 1_000_000 + 11 * 60_000), null, 'expired');
  const body = JSON.parse(new TextDecoder().decode(fromB64u(code.slice('knotdev1-'.length))));
  const forge = (change) => `knotdev1-${toB64u(
    new TextEncoder().encode(JSON.stringify({ ...body, ...change })),
  )}`;
  assert.equal(await readLinkRequest(forge({ name: 'Mallory' }), 1_000_000), null);
  assert.equal(await readLinkRequest(forge({ box: toB64u(randomBytes(32)) }), 1_000_000), null);
  for (const junk of ['', 'knotdev1-', 'knotdev1-%%%', 'nothing here', undefined]) {
    assert.equal(await readLinkRequest(junk), null);
  }
});

test('a grant is refused unless it is for this device, intact, and for this key', async () => {
  const [main, phone, other, attacker] = await Promise.all([1, 2, 3, 4].map(() => newIdentity()));
  const box = await newBoxKey();
  const code = await makeLinkRequest(phone, { name: 'Pixel', boxPub: box.pub });
  const request = await readLinkRequest(code);
  const grant = await makeLinkGrant(main, request, { name: 'Ada', rooms: rooms() });
  const read = (text, who = phone, key = box) => readLinkGrant(
    text, { identity: who, boxKey: key, boxPub: key.pub },
  );
  assert.ok(await read(grant.code));
  assert.equal(await read(grant.code, other), null, 'another device cannot use it');
  assert.equal(await read(grant.code, phone, await newBoxKey()), null, 'nor another one-time key');
  const middle = Math.floor(grant.code.length / 2);
  const other1 = grant.code[middle] === 'A' ? 'B' : 'A';
  const flipped = grant.code.slice(0, middle) + other1 + grant.code.slice(middle + 1);
  assert.equal(await read(flipped), null, 'any change breaks it');

  // A signature by an attacker's own key is genuine, but the six digits give it away.
  const evil = await makeLinkGrant(attacker, request, { name: 'Ada', rooms: rooms() });
  const fake = await read(evil.code);
  assert.equal(fake.mainId, attacker.id);
  assert.notEqual(fake.sas, grant.sas);

  // A certificate for some other key, sealed correctly and signed by the main key, is refused.
  const cert = await makeCert(main, other.pub, 'Other');
  const text = (s) => new TextEncoder().encode(s);
  const plain = text(JSON.stringify({ cert, name: 'Ada', rooms: [] }));
  const sealed = await sealBox(box.pub, plain, text(`knot/link-grant|${phone.id}`));
  const sig = await main.sign(new Uint8Array(
    [...text(`knot/link-grant-sig|${phone.id}`), ...sealed],
  ));
  const wire = new ByteWriter().u8(1).raw(main.pub).raw(sig).raw(sealed).done();
  const wrong = `knotdev2-${toB64u(wire)}`;
  assert.equal(await read(wrong), null);
});

test('with a certificate an envelope is written as the main identity', async () => {
  const [main, phone, other] = [await newIdentity(), await newIdentity(), await newIdentity()];
  await linkIdentity(main, phone);
  const clock = new HLC(Date.now, 500_000);
  const env = await createEnvelope(phone, clock, 'room1', 'text', 'from my phone', 'Ada');
  assert.equal(authorIdOf(env), main.id);
  assert.ok(env.c >= 500_000, 'its counters cannot collide with the main device');
  assert.equal(await verifyEnvelope(env, 'room1'), true);
  const bad = async (change) => verifyEnvelope({ ...env, ...change }, 'room1');
  const foreign = await makeCert(main, other.pub, 'Other');
  assert.equal(await bad({ cert: foreign }), false, 'a certificate for another key');
  const stranger = await makeCert(other, phone.pub, 'Pixel');
  assert.equal(await bad({ cert: stranger }), false, 'a certificate of someone else');
  assert.equal(await bad({ cert: undefined }), false, 'claims an identity the key is not');
  assert.equal(await bad({ id: env.id.replace(main.id, other.id) }), false);
  // Membership and unlinking stay with the main key itself.
  for (const kind of ['admit', 'revoke', 'transfer', 'unlink']) {
    const sneaky = await createEnvelope(phone, new HLC(), 'room1', kind, kind === 'unlink'
      ? unlinkBody(toB64u(other.pub)) : { id: other.id, name: 'x', prev: '' }, 'Ada');
    assert.equal(await verifyEnvelope(sneaky, 'room1'), false, kind);
  }
  const body = unlinkBody(toB64u(phone.pub));
  const own = await createEnvelope(main, new HLC(), 'room1', 'unlink', body, 'Ada');
  assert.equal(await verifyEnvelope(own, 'room1'), true);
  assert.equal(own.cert, undefined);
});
