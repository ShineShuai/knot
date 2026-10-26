import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageLog } from '../src/chat/log.js';
import {
  createEnvelope, delBody, quoteOf, replyBody, verifyEnvelope,
} from '../src/chat/envelope.js';
import { HLC } from '../src/util/hlc.js';
import { PeerLink } from '../src/net/peer-link.js';
import { newIdentity } from './helpers.js';

const room = 'room-1';
const make = async (who, kind, body, hlc = new HLC()) => (
  createEnvelope(who, hlc, room, kind, body, who.name ?? 'Ada')
);
const ok = (env) => verifyEnvelope(env, room);

test('reply: quote snapshot is signed and bounded', async () => {
  const [ada, bob] = [await newIdentity(), await newIdentity()];
  const hello = await make(ada, 'text', 'hello\n  there   world');
  const q = quoteOf(hello);
  assert.equal(q.text, 'hello there world');
  assert.equal(q.id, hello.id);
  const reply = await make(bob, 'reply', replyBody('hi back', q));
  assert.equal(await ok(reply), true);
  assert.equal(await ok({ ...reply, body: { ...reply.body, text: 'tampered' } }), false);
  const bad = (change) => make(bob, 'reply', { text: 'x', q: { ...q, ...change } });
  assert.equal(await ok(await bad({ text: 'x'.repeat(201) })), false);
  assert.equal(await ok(await bad({ id: 'no-dashes' })), false);
  assert.equal(await ok(await make(bob, 'reply', { text: '', q })), false);
  assert.equal(await ok(await make(bob, 'reply', { text: 'x' })), false);
  const file = await make(ada, 'file', { id: 'AAAAAAAAAAA', name: 'a.pdf', size: 1, mime: 'x',
    sha256: 'A'.repeat(43) });
  assert.equal(quoteOf(file).text, 'a.pdf');
});

test('del: only the author can delete, never itself', async () => {
  const [ada, bob] = [await newIdentity(), await newIdentity()];
  const hlc = new HLC(); // one clock: ids must differ
  const msg = await make(ada, 'text', 'oops', hlc);
  assert.equal(await ok(await make(ada, 'del', delBody(msg.id), hlc)), true);
  assert.equal(await ok(await make(bob, 'del', delBody(msg.id), hlc)), false); // not his message
  assert.equal(await ok(await make(ada, 'del', delBody('nonsense'), hlc)), false);
  const del = await make(ada, 'del', delBody(msg.id), hlc);
  assert.equal(await ok({ ...del, body: delBody(del.id) }), false); // itself
});

test('log: a deletion drops the content, remembers who did it, wins over late copies', async () => {
  const [ada, bob] = [await newIdentity(), await newIdentity()];
  const hlc = new HLC();
  const a = await make(ada, 'text', 'one', hlc);
  const b = await make(bob, 'text', 'two', hlc);
  const del = await make(ada, 'del', delBody(a.id), hlc);
  const log = new MessageLog();
  log.add(a);
  log.add(b);
  assert.equal(log.add(del), true);
  assert.equal(log.get(a.id), null);
  assert.equal(log.has(a.id), true); // known, so sync does not ask for it again
  assert.equal(log.isGone(a.id), true);
  assert.equal(log.add(a), false); // a late copy from a peer that has not heard yet
  const view = log.timeline();
  assert.deepEqual(view.map((e) => e.kind), ['gone', 'text']);
  assert.deepEqual(
    [view[0].id, view[0].by, view[0].name, view[0].at],
    [a.id, ada.id, del.name, del.ms],
  );
  assert.deepEqual(log.list().map((e) => e.kind).sort(), ['del', 'text']); // sync still sees del
});

test('log: a deletion may come before the message; deleting a deletion is void', async () => {
  const ada = await newIdentity();
  const hlc = new HLC();
  const a = await make(ada, 'text', 'one', hlc);
  const del = await make(ada, 'del', delBody(a.id), hlc);
  const log = new MessageLog();
  log.add(del);
  assert.equal(log.add(a), false);
  assert.deepEqual(log.timeline().map((e) => e.kind), ['gone']);
  const undo = await make(ada, 'del', delBody(del.id), hlc);
  log.add(undo);
  assert.equal(log.get(del.id).kind, 'del'); // still there: tombstones cannot be recalled
  assert.deepEqual(log.timeline().map((e) => e.kind), ['gone']);
});

test('log: trimming a deletion frees its tombstone', async () => {
  const ada = await newIdentity();
  const hlc = new HLC();
  const log = new MessageLog(2);
  const a = await make(ada, 'text', 'one', hlc);
  const del = await make(ada, 'del', delBody(a.id), hlc);
  log.add(del);
  log.add(await make(ada, 'text', 'two', hlc));
  log.add(await make(ada, 'text', 'three', hlc));
  assert.deepEqual(log.trim().map((e) => e.kind), ['del']);
  assert.equal(log.isGone(a.id), false);
});

test('PeerLink.stats reports how the link is routed', async () => {
  const stats = new Map([
    ['t', { id: 't', type: 'transport', selectedCandidatePairId: 'p' }],
    ['p', { id: 'p', type: 'candidate-pair', localCandidateId: 'l', remoteCandidateId: 'r',
      currentRoundTripTime: 0.0234 }],
    ['l', { id: 'l', type: 'local-candidate', candidateType: 'host', protocol: 'udp' }],
    ['r', { id: 'r', type: 'remote-candidate', candidateType: 'relay', protocol: 'udp' }],
  ]);
  const channel = () => ({});
  class FakeRTC {
    createDataChannel() { return channel(); }
    getStats = async () => stats;
  }
  const link = new PeerLink({ RTC: FakeRTC });
  const expected = { local: 'host', remote: 'relay', protocol: 'udp', rtt: 23 };
  assert.deepEqual(await link.stats(), expected);
  stats.delete('t'); // Firefox: no selected pair on the transport, use the nominated one
  stats.set('p', { ...stats.get('p'), nominated: true, state: 'succeeded' });
  assert.equal((await link.stats()).remote, 'relay');
  stats.clear();
  assert.equal(await link.stats(), null);
});
