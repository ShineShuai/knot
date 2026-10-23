import test from 'node:test';
import assert from 'node:assert/strict';
import { authorIdOf, createEnvelope, fileBody, verifyEnvelope } from '../src/chat/envelope.js';
import { MessageLog } from '../src/chat/log.js';
import { HLC } from '../src/util/hlc.js';
import { newIdentity } from './helpers.js';

const room = 'room-1';
const text = async (id, hlc, body, r = room) => createEnvelope(id, hlc, r, 'text', body, 'Ada');

test('envelopes verify; tampering, wrong room and forged authors fail', async () => {
  const [ada, eve] = [await newIdentity(), await newIdentity()];
  const e = await text(ada, new HLC(), 'hi');
  assert.equal(await verifyEnvelope(e, room), true);
  assert.equal(await verifyEnvelope({ ...e, body: 'hax' }, room), false);
  assert.equal(await verifyEnvelope(e, 'other-room'), false);
  const forged = { ...e, pub: (await text(eve, new HLC(), 'x')).pub }; // Eve's key, Ada's id
  assert.equal(await verifyEnvelope(forged, room), false);
  assert.equal(await verifyEnvelope({ ...e, body: 'x'.repeat(5000) }, room), false);
});

test('future-dated envelopes are refused', async () => {
  const e = await text(
    await newIdentity(),
    new HLC(() => Date.now() + 3600_000),
    'from the future',
  );
  assert.equal(await verifyEnvelope(e, room), false);
});

test('file envelopes validate their metadata', async () => {
  const id = await newIdentity();
  const body = fileBody(
    { id: 'AAAAAAAAAAA', name: 'a.txt', size: 3, mime: 'text/plain', sha256: 'A'.repeat(43) },
  );
  const e = await createEnvelope(id, new HLC(), room, 'file', body, 'Ada');
  assert.equal(await verifyEnvelope(e, room), true);
  assert.equal(await verifyEnvelope(e, room, { maxFileBytes: 2 }), false);
});

test('log orders by stamp, de-duplicates, trims FIFO and computes sync deltas', async () => {
  const id = await newIdentity();
  let t = 1000;
  const hlc = new HLC(() => t++);
  const log = new MessageLog(3);
  const envs = [];
  for (const body of ['a', 'b', 'c', 'd']) envs.push(await text(id, hlc, body));
  for (const e of [envs[2], envs[0], envs[3], envs[1]]) assert.ok(log.add(e));
  assert.equal(log.add(envs[0]), false);
  assert.deepEqual(log.list().map((e) => e.body), ['a', 'b', 'c', 'd']);
  assert.deepEqual(log.trim().map((e) => e.body), ['a']);
  assert.deepEqual(log.recentIds(2), [envs[2].id, envs[3].id]);
  assert.deepEqual(log.missingFor([envs[1].id], false).map((e) => e.body), ['c', 'd']);
  // their report was a truncated window starting at envs[2]: older ones are out of scope
  assert.deepEqual(log.missingFor([envs[2].id], true).map((e) => e.body), ['d']);
});

test('authorIdOf survives peer ids that contain dashes', async () => {
  assert.equal(authorIdOf({ id: 'abc-1-ab-cd_ef' }), 'ab-cd_ef');
  let withDash = null;
  while (!withDash) { // about 1 in 6 identities has a dash in its peer id
    const candidate = await newIdentity();
    if (candidate.id.includes('-')) withDash = candidate;
  }
  const env = await text(withDash, new HLC(), 'hi');
  assert.equal(authorIdOf(env), withDash.id);
  assert.equal(await verifyEnvelope(env, room), true);
});
