import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/chat/room.js';
import { DEFAULTS } from '../src/config.js';
import { decodeCode } from '../src/net/handshake.js';
import { newRoomSecret } from '../src/crypto/room-keys.js';
import { validSdp } from '../src/call/call-link.js';
import { MemoryKV } from '../src/store/kv.js';
import { newIdentity } from './helpers.js';
import { FakeLink, until } from './fakes.js';
import { callParty, sending } from './call-fakes.js';

const rooms = [];
test.afterEach(() => { rooms.splice(0).forEach((r) => r.stop()); });

/** `n` rooms (one secret, all linked pairwise) with fake media: [{ room, id, made, media }]. */
async function party(n, { denied, extra = {} } = {}) {
  const secret = newRoomSecret();
  const people = [];
  for (let i = 0; i < n; i++) {
    const pieces = callParty({ denied: i === 0 ? denied : undefined });
    const identity = await newIdentity();
    const settings = {
      ...DEFAULTS, name: `P${i}`, brokersEnabled: false, brokers: [], gatherTimeoutMs: 10,
      connectTimeoutMs: 2000, callRetryMs: 20, ...extra,
    };
    const room = await Room.open({
      identity, secret, label: `P${i}`, kv: new MemoryKV(), settings, iceServers: () => [],
      linkFactory: () => new FakeLink(), callEnv: pieces.env,
    });
    rooms.push(room);
    people.push({ room, id: identity.id, ...pieces });
  }
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const offer = decodeCode((await people[i].room.createInvite()).code);
    const reply = await people[j].room.answerOffer(offer);
    await people[i].room.acceptAnswer(decodeCode(reply.code));
  }
  const linked = (p) => p.room.peerList.filter((x) => x.state === 'p2p').length === n - 1;
  await until(() => people.every(linked));
  return people;
}

const connected = (p, n) => p.room.call.participants.length === n
  && p.room.call.participants.every((x) => x.state === 'connected');

test('two people join: each hears who is in the call, then media connects both ways', async () => {
  const [a, b] = await party(2);
  assert.deepEqual(await a.room.call.join(), { audio: true, video: false });
  await until(() => b.room.call.members.has(a.id));
  assert.equal(b.room.call.joined, false); // seeing a call does not join it
  assert.deepEqual(await b.room.call.join({ video: true }), { audio: true, video: true });
  await until(() => connected(a, 1) && connected(b, 1));
  assert.equal(a.room.call.participants[0].stream.getTracks().length, 2);
  assert.equal(sending(b.made[0], 'video'), b.media.tracks[1]);
  assert.equal(sending(a.made[0], 'audio'), a.media.tracks[0]);
  assert.equal(sending(a.made[0], 'video'), null); // camera was off for a
});

test('the peer with the smaller id makes the offer', async () => {
  const [a, b] = await party(2);
  await Promise.all([a.room.call.join(), b.room.call.join()]);
  await until(() => connected(a, 1) && connected(b, 1));
  const [low, high] = a.id < b.id ? [a, b] : [b, a];
  assert.equal(low.made.length, 1);
  assert.equal(high.made.length, 1);
  assert.equal(low.made[0].offerer, true);
  assert.equal(high.made[0].offerer, false);
});

test('mute and camera changes reach the other side; the camera is released when off', async () => {
  const [a, b] = await party(2);
  await Promise.all([a.room.call.join({ video: true }), b.room.call.join()]);
  await until(() => connected(a, 1) && connected(b, 1));
  const [mic, cam] = a.media.tracks;
  assert.equal(await a.room.call.setAudio(false), false);
  await until(() => b.room.call.members.get(a.id).a === false);
  assert.equal(mic.enabled, false);
  assert.equal(await a.room.call.setVideo(false), false);
  await until(() => b.room.call.members.get(a.id).v === false);
  assert.equal(cam.stopped, true);
  assert.equal(sending(a.made[0], 'video'), null);
  assert.equal(await a.room.call.setVideo(true), true);
  assert.notEqual(sending(a.made[0], 'video'), cam); // a fresh capture, same connection
  assert.equal(a.made.length, 1);
  await until(() => b.room.call.members.get(a.id).v === true);
});

test('leaving closes the connections and releases the devices', async () => {
  const [a, b] = await party(2);
  await Promise.all([a.room.call.join({ video: true }), b.room.call.join()]);
  await until(() => connected(a, 1) && connected(b, 1));
  a.room.call.leave();
  assert.equal(a.room.call.joined, false);
  assert.ok(a.media.tracks.every((t) => t.stopped));
  assert.ok(a.made.every((rtc) => rtc.connectionState === 'closed'));
  await until(() => b.room.call.participants.length === 0);
  assert.equal(b.room.call.joined, true); // the call goes on for those still in it
  await a.room.call.join(); // and we can come back
  await until(() => connected(a, 1) && connected(b, 1));
});

test('three people form a mesh and share the video bandwidth', async () => {
  const people = await party(3);
  await Promise.all(people.map((p) => p.room.call.join({ video: true })));
  await until(() => people.every((p) => connected(p, 2)));
  for (const p of people) {
    assert.equal(p.made.length, 2);
    for (const rtc of p.made) {
      const video = rtc.getTransceivers().find((t) => t.receiver.track.kind === 'video');
      assert.equal(video.sender.params.encodings[0].maxBitrate, 450_000);
    }
  }
});

test('a call has a size limit', async () => {
  const [a, b, c] = await party(3, { extra: { callMaxParticipants: 2 } });
  await a.room.call.join();
  await b.room.call.join();
  await until(() => c.room.call.members.size === 2);
  await assert.rejects(c.room.call.join(), /full/);
  assert.equal(c.room.call.joined, false);
});

test('a refused microphone does not keep you out: you can still listen', async () => {
  const [a, b] = await party(2, { denied: ['audio'] });
  assert.deepEqual(await a.room.call.join(), { audio: false, video: false });
  assert.equal(a.room.call.joined, true);
  assert.equal(await a.room.call.setAudio(true), false);
  await b.room.call.join();
  await until(() => connected(a, 1) && connected(b, 1));
  assert.equal(b.room.call.members.get(a.id).a, false);
});

test('a connection that fails is offered again by the offering side', async () => {
  const [a, b] = await party(2);
  await Promise.all([a.room.call.join(), b.room.call.join()]);
  await until(() => connected(a, 1) && connected(b, 1));
  const [low, high] = a.id < b.id ? [a, b] : [b, a];
  low.made[0].fail();
  await until(() => low.made.length === 2 && connected(low, 1) && connected(high, 1));
  assert.equal(high.made.length, 2);
  assert.equal(high.made[0].connectionState, 'closed'); // replaced, not leaked
});

test('a peer whose link drops is out of the call', async () => {
  const [a, b] = await party(2);
  await Promise.all([a.room.call.join(), b.room.call.join()]);
  await until(() => connected(a, 1));
  a.room.peers.get(b.id).link.close();
  await until(() => a.room.call.participants.length === 0);
  assert.ok(a.made.every((rtc) => rtc.connectionState === 'closed'));
});

test('malformed, unannounced and wrongly directed offers are ignored', async () => {
  const [a, b] = await party(2);
  const [low, high] = a.id < b.id ? [a, b] : [b, a];
  const good = 'v=0\r\nm=audio 9 RTP/AVP 0\r\nm=video 9 RTP/AVP 96\r\n';
  await high.room.call.join();
  high.room.call.onFrame(low.id, { k: 'offer', sid: 's1', sdp: good }); // low never announced
  await low.room.call.join();
  await until(() => high.made.length === 1); // the genuine offer low made after joining
  for (const m of [
    { k: 'offer', sid: 's2', sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP x\r\n' },
    { k: 'offer', sid: 's3', sdp: `${good}m=video 9 RTP/AVP 97\r\n` },
    { k: 'offer', sid: 5, sdp: good },
    { k: 'offer', sid: 's4', sdp: 'x'.repeat(30_000) },
    { k: 'answer', sid: 'nope', sdp: good },
    { k: 'bogus' },
    null,
  ]) high.room.call.onFrame(low.id, m);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(high.made.length, 1); // none of the above opened a connection
  low.room.call.onFrame(high.id, { k: 'offer', sid: 's5', sdp: good }); // low is the offerer
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(low.made.length, 1);
});

test('only the two media sections we create are accepted', () => {
  const ok = 'v=0\r\nm=audio 9 RTP/AVP 0\r\nm=video 9 RTP/AVP 96\r\n';
  assert.equal(validSdp(ok), true);
  assert.equal(validSdp('v=0\r\nm=video 9 RTP/AVP 96\r\nm=audio 9 RTP/AVP 0\r\n'), false);
  assert.equal(validSdp('v=0\r\nm=audio 9 RTP/AVP 0\r\n'), false);
  assert.equal(validSdp(`${ok}m=application 9 UDP/DTLS/SCTP x\r\n`), false);
  assert.equal(validSdp(undefined), false);
});

test('a device that disappears mid-call is dropped without ending the call', async () => {
  const [a, b] = await party(2);
  await Promise.all([a.room.call.join({ video: true }), b.room.call.join()]);
  await until(() => connected(a, 1));
  const [, cam] = a.media.tracks;
  cam.end();
  await until(() => b.room.call.members.get(a.id).v === false);
  assert.equal(a.room.call.joined, true);
  assert.equal(sending(a.made[0], 'video'), null);
});
