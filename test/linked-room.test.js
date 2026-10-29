// A linked device inside rooms: it writes as the main identity, others accept it, and unlinking
// cuts it off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { authorIdOf, createEnvelope } from '../src/chat/envelope.js';
import { decodeCode } from '../src/net/handshake.js';
import { newRoomSecret } from '../src/crypto/room-keys.js';
import { HLC } from '../src/util/hlc.js';
import { newIdentity } from './helpers.js';
import { FakeBroker, until } from './fakes.js';
import { link, linkIdentity, makeRoom, stopRooms } from './room-kit.js';

test.afterEach(stopRooms);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ada's main device `a`, her linked phone `b`, and Bob, all in one open room. */
async function trio() {
  const secret = newRoomSecret();
  const [main, phone] = [await newIdentity(), await newIdentity()];
  const cert = await linkIdentity(main, phone);
  const a = await makeRoom({ secret, name: 'Ada', identity: main });
  const b = await makeRoom({ secret, name: 'Ada', identity: phone });
  const bob = await makeRoom({ secret, name: 'Bob' });
  await link(a, bob);
  await link(b, bob);
  return { a, b, bob, main, phone, cert };
}

const inject = (room, env) => [...room.peers.values()][0].link.peer.emit(
  'chat', JSON.stringify({ t: 'msg', e: env }),
);

test('a linked device writes as the main identity; both devices see it as their own', async () => {
  const { a, b, bob, main } = await trio();
  const env = await b.sendText('from my phone');
  await until(() => bob.log.get(env.id) && a.log.get(env.id));
  assert.equal(authorIdOf(bob.log.get(env.id)), main.id);
  assert.ok(env.cert, 'the certificate travels with it');
  assert.equal(a.isMine(authorIdOf(env)), true);
  assert.equal(b.isMine(authorIdOf(env)), true);
  assert.equal(bob.isMine(authorIdOf(env)), false);
  assert.equal(a.unread, 0, 'not news to the main device');
  assert.equal(bob.unread, 1);

  await a.editMessage(env.id, 'edited on the main device'); // same person
  await until(() => bob.log.textOf(bob.log.get(env.id)) === 'edited on the main device');
  await a.deleteMessage(env.id);
  await until(() => bob.log.isGone(env.id));
});

test('only the main device unlinks; the unlinked device is cut off everywhere', async () => {
  const { a, b, bob, phone, cert } = await trio();
  await assert.rejects(b.unlinkDevice(cert.d), /Only the main device/);
  let told = 0;
  b.on('unlinked', () => told++);
  await a.unlinkDevice(cert.d);
  await until(() => told === 1); // Bob passed the news on before dropping the link
  await assert.rejects(b.sendText('still here?'), /unlinked/);
  await until(() => !bob.peerList.some((p) => p.id === phone.id && p.state === 'p2p'));

  const clock = new HLC(Date.now, 500_000);
  const late = await createEnvelope(phone, clock, bob.id, 'text', 'late', 'Ada');
  inject(bob, late);
  await wait(30);
  assert.equal(bob.log.get(late.id), null, 'what it writes now is refused');
  await a.sendText('still me'); // the main identity is unaffected
  await until(() => bob.log.list().some((e) => e.body === 'still me'));

  const cy = await makeRoom({ secret: bob.secret, name: 'Cy' }); // learns it from the history
  await link(bob, cy);
  await until(() => cy.log.where((e) => e.kind === 'unlink').length === 1);
  inject(cy, late);
  await wait(30);
  assert.equal(cy.log.get(late.id), null);
});

test('a file shared from the linked device is fetched from that device', async () => {
  const { a, b, bob } = await trio();
  const env = await b.shareFile(new File(['hello from the phone'], 'note.txt'));
  await until(() => bob.log.get(env.id));
  const blob = await bob.downloadFile(bob.log.get(env.id));
  assert.equal(await blob.text(), 'hello from the phone');
  assert.equal(a.peerList.length >= 1, true);
});

test('in an owned room a linked device is let in as its main identity', async () => {
  const broker = new FakeBroker();
  const [boss, main, phone] = [await newIdentity(), await newIdentity(), await newIdentity()];
  const cert = await linkIdentity(main, phone);
  const owner = await makeRoom({ name: 'Boss', identity: boss, owner: boss.id, broker });
  const offer = decodeCode((await owner.createInvite()).code);
  const a = await makeRoom({
    name: 'Ada', secret: offer.roomSecret, owner: offer.founder, identity: main,
  });
  await owner.acceptAnswer(decodeCode((await a.answerOffer(offer)).code));
  await until(() => owner.roster.isMember(main.id) && a.roster.isMember(main.id));

  const b = await makeRoom({
    name: 'Ada', secret: owner.secret, owner: boss.id, identity: phone, broker,
  });
  owner.start();
  b.start();
  await until(() => owner.peerList.some((p) => p.id === phone.id && p.state === 'p2p'));
  assert.equal(owner.roster.isMember(phone.id), false, 'the phone key was never admitted itself');
  const env = await b.sendText('hi from the phone');
  await until(() => owner.log.get(env.id));
  assert.equal(authorIdOf(owner.log.get(env.id)), main.id);
  const row = owner.membersView().find((m) => m.id === main.id);
  assert.equal(row.state, 'p2p', 'and it counts as Ada being online');

  await owner.removeMember(main.id); // removing the person removes all her devices
  await until(() => !owner.peerList.some((p) => p.state === 'p2p'));
  assert.equal(cert.d.length, 43);
});
