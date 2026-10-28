// Reactions and edits: signed envelopes that ride on another message.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvelope, editBody, reactBody, verifyEnvelope } from '../src/chat/envelope.js';
import { HLC } from '../src/util/hlc.js';
import { newRoomSecret } from '../src/crypto/room-keys.js';
import { MemoryKV } from '../src/store/kv.js';
import { until } from './fakes.js';
import { link, makeRoom, pairRooms, stopRooms } from './room-kit.js';

test.afterEach(stopRooms);

const reactors = (room, id, emoji) => room.log.overlay().reactions.get(id)?.get(emoji) ?? [];
const slots = (room) => room.log.where((e) => ['edit', 'react'].includes(e.kind));

test('reactions reach everyone and toggle off; one slot per person and emoji', async () => {
  const [a, b] = await pairRooms();
  const msg = await a.sendText('lunch?');
  await until(() => b.log.get(msg.id));
  await b.react(msg.id, '👍');
  await a.react(msg.id, '👍');
  await a.react(msg.id, '😂');
  const count = (room, emoji) => reactors(room, msg.id, emoji).length;
  await until(() => count(a, '👍') === 2 && count(b, '😂') === 1);
  // everyone sees the same people in the same order
  assert.deepEqual(reactors(a, msg.id, '👍'), reactors(b, msg.id, '👍'));
  await b.react(msg.id, '👍'); // taking it back
  await until(() => count(a, '👍') === 1 && count(b, '👍') === 1);
  assert.equal(reactors(a, msg.id, '👍')[0], a.identity.id);
  await a.react(msg.id, '👍');
  await until(() => !reactors(b, msg.id, '👍').length);
  assert.equal(slots(a).length, 3, 'one envelope per (person, emoji), not one per click');
  assert.equal(a.log.timeline().length, 1, 'reactions are not messages');
});

test('only an emoji, on a message that exists, can be reacted with', async () => {
  const [a] = await pairRooms();
  const msg = await a.sendText('hi');
  await assert.rejects(a.react(msg.id, 'yes'), /emoji/);
  await assert.rejects(a.react(msg.id, '👍👍'), /emoji/);
  await assert.rejects(a.react('1-1-nobody', '👍'), /gone/);
  const forged = await createEnvelope(a.identity, new HLC(), a.id, 'react',
    reactBody(msg.id, 'FREE MONEY', true), 'Ada');
  assert.equal(await verifyEnvelope(forged, a.id), false); // peers refuse it too
});

test('only the author edits; the newest edit wins and replaces the older one', async () => {
  const [a, b] = await pairRooms();
  const msg = await a.sendText('helo');
  await until(() => b.log.get(msg.id));
  await assert.rejects(b.editMessage(msg.id, 'hijack'), /own messages/);
  const forged = await createEnvelope(b.identity, new HLC(), b.id, 'edit',
    editBody(msg.id, 'hijack'), 'Bob');
  [...a.peers.values()][0].link.peer.emit('chat', JSON.stringify({ t: 'msg', e: forged }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(a.log.textOf(msg), 'helo', 'an edit by someone else is ignored');

  await a.editMessage(msg.id, 'hello');
  await a.editMessage(msg.id, 'hello there');
  await until(() => b.log.textOf(msg) === 'hello there');
  assert.equal(a.log.isEdited(msg), true);
  assert.equal(slots(a).length, 1);
  assert.equal(slots(b).length, 1);
  assert.equal(await a.editMessage(msg.id, 'hello there'), null); // unchanged: nothing sent
  await assert.rejects(a.editMessage(msg.id, '  '), /empty/);
  assert.equal(msg.body, 'helo', 'the signed original is untouched');
});

test('an older edit that arrives late does not win', async () => {
  const [a] = await pairRooms();
  const c = await makeRoom({ secret: a.secret, name: 'Cy' }); // has seen none of it
  const msg = await a.sendText('one');
  const first = await a.editMessage(msg.id, 'two');
  const second = await a.editMessage(msg.id, 'three');
  await c.receiveAdmin(second); // `receiveAdmin` feeds any envelope into the usual checks
  await c.receiveAdmin(first);
  await c.receiveAdmin(msg);
  assert.equal(c.log.textOf(msg), 'three');
  assert.equal(slots(c).length, 1);
});

test('deleting a message takes its edits and reactions along and refuses later ones', async () => {
  const kv = new MemoryKV();
  const secret = newRoomSecret();
  const a = await makeRoom({ secret, name: 'Ada', kv });
  const b = await makeRoom({ secret, name: 'Bob' });
  await link(a, b);
  const msg = await a.sendText('secret');
  await until(() => b.log.get(msg.id));
  await a.editMessage(msg.id, 'secret v2');
  await b.react(msg.id, '👍');
  await until(() => slots(a).length === 2 && slots(b).length === 2);
  await a.deleteMessage(msg.id);
  await until(() => !slots(a).length && !slots(b).length);
  assert.equal(a.log.size, 1); // only the deletion itself
  assert.equal((await kv.list(`m:${a.id}:`)).length, 1, 'and nothing else is stored');
  const late = await createEnvelope(b.identity, new HLC(), b.id, 'react',
    reactBody(msg.id, '😂', true), 'Bob');
  [...a.peers.values()][0].link.peer.emit('chat', JSON.stringify({ t: 'msg', e: late }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(slots(a).length, 0);
  await assert.rejects(b.react(msg.id, '😂'), /gone/);
});

test('a member who joins later gets edits and reactions with the history', async () => {
  const [a] = await pairRooms();
  const msg = await a.sendText('v1');
  await a.editMessage(msg.id, 'v2');
  await a.react(msg.id, '❤️');
  const late = await makeRoom({ secret: a.secret, name: 'Cy' });
  await link(a, late);
  await until(() => late.log.get(msg.id) && late.log.textOf(msg) === 'v2');
  await until(() => reactors(late, msg.id, '❤️').length === 1);
});

test('a reply quotes the edited text', async () => {
  const [a, b] = await pairRooms();
  const msg = await a.sendText('teh plan');
  await a.editMessage(msg.id, 'the plan');
  await until(() => b.log.textOf(b.log.get(msg.id) ?? msg) === 'the plan');
  const reply = await b.sendText('agreed', b.log.get(msg.id));
  assert.equal(reply.body.q.text, 'the plan');
});
