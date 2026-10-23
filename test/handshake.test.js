import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSdp, parseSdp } from '../src/net/sdp.js';
import {
  decodeCode,
  encodeCode,
  shortAuthString,
  signHandshake,
  unpackHandshake,
  verifyHandshake,
} from '../src/net/handshake.js';
import { randomBytes } from '../src/util/bytes.js';
import { newIdentity, sampleSdp } from './helpers.js';

test('parseSdp keeps UDP candidates of every address kind, drops tcp and link-local', () => {
  const info = parseSdp(sampleSdp());
  assert.equal(info.ufrag, 'abcd');
  assert.equal(info.fingerprint.length, 32);
  assert.equal(info.sctpPort, 5000);
  assert.equal(info.maxMessage, 262144);
  assert.deepEqual(info.candidates.map((c) => c.type), ['host', 'srflx', 'host', 'host']);
});

test('buildSdp output parses back to the same info', () => {
  const info = parseSdp(sampleSdp());
  for (const role of ['offer', 'answer']) assert.deepEqual(parseSdp(buildSdp(info, role)), info);
  assert.match(buildSdp(info, 'answer'), /a=setup:active/);
  assert.match(buildSdp(info, 'offer'), /a=setup:actpass/);
});

async function makeOffer(identity, extra = {}) {
  return signHandshake(identity, {
    kind: 'offer', session: randomBytes(8), ts: Date.now(), name: 'Ada', roomSecret: randomBytes(
      16,
    ),
    sdp: parseSdp(sampleSdp()), ...extra,
  });
}

test('handshake survives pack -> code -> unpack and verifies', async () => {
  const id = await newIdentity();
  const h = await makeOffer(id);
  const back = decodeCode(`join me: https://x.example/#c=${encodeCode(h)} thanks`);
  assert.equal(back.kind, 'offer');
  assert.equal(back.name, 'Ada');
  assert.deepEqual(back.roomSecret, h.roomSecret);
  assert.deepEqual(back.sdp.candidates.map((c) => c.host), [
    'd3b1c8a4-6a77-4a0e-9a5c-0e5d1f2c3b4a.local', '203.0.113.7', '2001:db8:0:0:0:0:0:1234']);
  assert.equal(await verifyHandshake(back), id.id);
});

test('compact code stays small enough for a QR code', async () => {
  const h = await makeOffer(await newIdentity());
  assert.ok(encodeCode(h).length < 420, `code length ${encodeCode(h).length}`);
});

test('tampering, expiry and garbage are rejected', async () => {
  const id = await newIdentity();
  const h = await makeOffer(id);
  const bad = unpackHandshake(Uint8Array.from(h.wire, (b, i) => (i === 40 ? b ^ 1 : b)));
  await assert.rejects(verifyHandshake(bad), /Signature/);
  await assert.rejects(verifyHandshake(h, { now: Date.now() + 3600_000 }), /expired/);
  assert.equal(decodeCode('not a code'), null);
  assert.equal(decodeCode('knot1-AAAA'), null);
});

test('short authentication string is symmetric and depends on both fingerprints', async () => {
  const [a, b, c] = [randomBytes(32), randomBytes(32), randomBytes(32)];
  assert.equal(await shortAuthString(a, b), await shortAuthString(b, a));
  assert.notEqual(await shortAuthString(a, b), await shortAuthString(a, c));
  assert.match(await shortAuthString(a, b), /^\d{3} \d{3}$/);
});
