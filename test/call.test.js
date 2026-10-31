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
import { callParty, sending, videoEncoding } from './call-fakes.js';
import { callLines, diagnosticsReport } from '../src/ui/diagnostics.js';

const rooms = [];
test.afterEach(() => { rooms.splice(0).forEach((r) => r.stop()); });

/** `n` rooms (one secret, all linked pairwise) with fake media: [{ room, id, made, media }]. */
async function party(n, { denied, share, extra = {} } = {}) {
  const secret = newRoomSecret();
  const people = [];
  for (let i = 0; i < n; i++) {
    const pieces = callParty({
      denied: i === 0 ? denied : undefined, share: i === 0 ? share : undefined,
    });
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

test('three people form a mesh; each stream starts at a steady, shared-uplink rung', async () => {
  const people = await party(3);
  await Promise.all(people.map((p) => p.room.call.join({ video: true })));
  await until(() => people.every((p) => connected(p, 2)));
  for (const p of people) {
    assert.equal(p.made.length, 2);
    for (const rtc of p.made) {
      const params = videoEncoding(rtc);
      const [encoding] = params.encodings;
      assert.equal(encoding.active, true);
      assert.equal(encoding.maxBitrate, 500_000); // 360p at 30 fps to begin with
      assert.equal(encoding.maxFramerate, 30);
      assert.equal(encoding.scaleResolutionDownBy, 2); // 720 captured, 360 sent
      assert.equal(params.degradationPreference, 'maintain-framerate'); // keep motion smooth
    }
  }
});

test('the receiver says how big it shows our video; we send no more than that', async () => {
  const [a, b] = await party(2);
  await a.room.call.join({ video: true });
  await b.room.call.join({ video: true });
  await until(() => connected(a, 1) && connected(b, 1));
  const encoding = () => videoEncoding(a.made[0]).encodings[0];
  const writes = () => a.made[0].getTransceivers()[1].sender.writes;

  b.room.call.setWant(a.id, 180); // a thumbnail
  await until(() => encoding().maxBitrate === 100_000);
  assert.equal(encoding().scaleResolutionDownBy, 4);
  assert.equal(encoding().maxFramerate, 15);

  b.room.call.setWant(a.id, 0); // not shown: no video at all
  await until(() => encoding().active === false);

  b.room.call.setWant(a.id, 1080); // full screen: video resumes where the link has proven itself
  await until(() => encoding().active === true && encoding().maxBitrate === 500_000);
  assert.equal(encoding().scaleResolutionDownBy, 2); // more only once measurements allow it

  const before = writes();
  b.room.call.setWant(a.id, 1080); // saying it again changes nothing
  b.room.call.setWant(a.id, 99_999); // nonsense is clamped, not trusted blindly
  a.room.call.onFrame(b.id, { k: 'want', h: -5 });
  a.room.call.onFrame(b.id, { k: 'want', h: 'tall' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(writes(), before);
});

test('a shared screen has its own profile: sharp text first, frame rate second', async () => {
  const [a, b] = await party(2);
  await a.room.call.join({ video: true });
  await b.room.call.join();
  await until(() => connected(a, 1) && connected(b, 1));
  await a.room.call.setScreen(true);
  const params = () => videoEncoding(a.made[0]);
  await until(() => params().degradationPreference === 'maintain-resolution');
  const [encoding] = params().encodings;
  assert.equal(encoding.maxFramerate, 8); // 720p at 8 fps to begin with
  assert.equal(encoding.maxBitrate, 500_000);
  await a.room.call.setScreen(false);
  await until(() => params().degradationPreference === 'maintain-framerate');
});

const stats = ({ loss = 0, rtt = 0.05, available } = {}) => [
  { type: 'outbound-rtp', kind: 'video', bytesSent: 1000, timestamp: 0 },
  { type: 'remote-inbound-rtp', kind: 'video', fractionLost: loss, roundTripTime: rtt },
  ...(available ? [{
    type: 'candidate-pair', nominated: true, state: 'succeeded',
    availableOutgoingBitrate: available,
  }] : []),
];

test('a connection that cannot carry video drops it, says so, and tries again later', async () => {
  const [a, b] = await party(2);
  await a.room.call.join({ video: true });
  await b.room.call.join();
  await until(() => connected(a, 1) && connected(b, 1));
  const encoding = () => videoEncoding(a.made[0]).encodings[0];
  const { clock } = a;

  a.made[0].stats = stats({ loss: 0.3 }); // heavy loss: two rungs down at once
  clock.t = 10_000;
  await a.room.call.adapt();
  await until(() => encoding().maxBitrate === 100_000);
  assert.equal(b.room.call.participants[0].paused, false);

  clock.t = 14_000; // still bad at the lowest rung: audio only
  await a.room.call.adapt();
  await until(() => encoding().active === false);
  await until(() => b.room.call.participants[0].paused === true);
  assert.equal(a.room.call.joined, true);

  a.made[0].stats = stats(); // the network recovers
  clock.t = 20_000; // too soon to try again
  await a.room.call.adapt();
  assert.equal(encoding().active, false);
  clock.t = 30_000;
  await a.room.call.adapt();
  await until(() => encoding().active === true);
  await until(() => b.room.call.participants[0].paused === false);
});

test('a calm connection climbs one rung at a time, never past what the people allow', async () => {
  const [a, b] = await party(2);
  await a.room.call.join({ video: true });
  await b.room.call.join();
  await until(() => connected(a, 1) && connected(b, 1));
  const encoding = () => videoEncoding(a.made[0]).encodings[0];
  a.made[0].stats = stats({ available: 5_000_000 });
  for (let t = 2000; t <= 40_000; t += 2000) { a.clock.t = t; await a.room.call.adapt(); }
  await until(() => encoding().maxBitrate === 1_800_000); // 720p, the top for two
  assert.equal(encoding().maxFramerate, 30);
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

test('sharing the screen replaces the camera on the wire, and it comes back after', async () => {
  const [a, b] = await party(2);
  await Promise.all([a.room.call.join({ video: true }), b.room.call.join()]);
  await until(() => connected(a, 1) && connected(b, 1));
  const cam = a.media.tracks[1];
  assert.equal(a.room.call.canShare, true);
  assert.equal(await a.room.call.setScreen(true), true);
  const screen = a.media.tracks[2];
  assert.equal(screen.screen, true);
  assert.equal(sending(a.made[0], 'video'), screen);
  await until(() => b.room.call.members.get(a.id).s === true);
  assert.equal(b.room.call.members.get(a.id).v, true);
  assert.deepEqual(a.room.call.local, { a: true, v: true, s: true }, 'the camera stays on');
  assert.equal(cam.stopped, false);
  assert.equal(a.room.call.localStream.getTracks()[0], screen);
  assert.equal(await a.room.call.setScreen(false), false);
  assert.equal(screen.stopped, true);
  assert.equal(sending(a.made[0], 'video'), cam);
  await until(() => b.room.call.members.get(a.id).s === false);
  assert.equal(a.made.length, 1, 'no new connection was needed');
});

test('a screen can be shared without a camera; the browser\'s own button ends it', async () => {
  const [a, b] = await party(2);
  await Promise.all([a.room.call.join(), b.room.call.join()]);
  await until(() => connected(a, 1) && connected(b, 1));
  assert.equal(b.room.call.members.get(a.id).v, false);
  await a.room.call.setScreen(true);
  await until(() => b.room.call.members.get(a.id).v === true);
  const [, screen] = a.media.tracks;
  screen.end(); // "Stop sharing" in the browser
  await until(() => b.room.call.members.get(a.id).s === false);
  assert.equal(b.room.call.members.get(a.id).v, false);
  assert.equal(sending(a.made[0], 'video'), null);
  assert.equal(a.room.call.joined, true);
});

test('a cancelled picker changes nothing; leaving stops a running share', async () => {
  const [a, b] = await party(2, { denied: ['screen'] });
  await Promise.all([a.room.call.join(), b.room.call.join()]);
  assert.equal(await a.room.call.setScreen(true), false);
  assert.equal(a.room.call.local.s, false);
  const [c, d] = await party(2);
  await Promise.all([c.room.call.join(), d.room.call.join()]);
  await c.room.call.setScreen(true);
  const [, screen] = c.media.tracks;
  c.room.call.leave();
  assert.equal(screen.stopped, true);
  assert.equal(c.room.call.local.s, false);
  assert.equal(b.room.call.joined, true);
});

test('a browser that cannot capture the screen does not offer it', async () => {
  const [a] = await party(2, { share: false });
  assert.equal(a.room.call.canShare, false);
});

const richStats = (bytes, ts) => [
  {
    type: 'outbound-rtp', kind: 'video', bytesSent: bytes, timestamp: ts, framesPerSecond: 29,
    frameWidth: 640, frameHeight: 360, qualityLimitationReason: 'none',
  },
  {
    type: 'inbound-rtp', kind: 'video', framesPerSecond: 24, frameWidth: 320, frameHeight: 180,
    freezeCount: 1,
  },
  { type: 'remote-inbound-rtp', kind: 'video', fractionLost: 0.02, roundTripTime: 0.08 },
  {
    type: 'candidate-pair', nominated: true, state: 'succeeded',
    availableOutgoingBitrate: 2_000_000,
  },
];

test('the diagnostics list every connection: what is sent, measured and asked for', async () => {
  const [a, b] = await party(2);
  await a.room.call.join({ video: true });
  await b.room.call.join();
  await until(() => connected(a, 1) && connected(b, 1));
  assert.deepEqual(callLines(b.room).length, 1);
  assert.match(callLines(a.room)[0], /no statistics yet/);

  a.made[0].stats = richStats(0, 0);
  a.clock.t = 2000;
  await a.room.call.adapt();
  a.made[0].stats = richStats(125_000, 2000); // 500 kb/s over two seconds
  a.clock.t = 4000;
  await a.room.call.adapt();
  b.room.call.setWant(a.id, 360);
  await until(() => a.room.call.quality()[0].demand === 360);

  const [row] = a.room.call.quality();
  assert.equal(row.send.kbps, 500);
  assert.deepEqual(row.recv, { fps: 24, w: 320, h: 180, freezes: 1 });
  const line = callLines(a.room)[0];
  assert.match(line, /^call [\w-]{6} connected \| camera rung 3\/5 \(proven 3\)/);
  assert.match(line, /shown to them at 360 px, theirs at \? px/);
  assert.match(line, /send 500k 640x360@29 loss 2% rtt 80 ms limit none estimate 2000k/);
  assert.match(line, /recv 320x180@24 freezes 1$/);

  const model = { kv: new MemoryKV(), rooms: new Map([[a.room.id, a.room]]), settings: {} };
  const report = await diagnosticsReport(model, { navigator: { userAgent: 'test' } });
  assert.ok(report.includes(line), 'the report carries the call lines');
  a.room.call.leave();
  assert.deepEqual(callLines(a.room), []);
});

test('a call that sends no video measures its connections but does not adapt them', async () => {
  const [a, b] = await party(2);
  await a.room.call.join();
  await b.room.call.join();
  await until(() => connected(a, 1) && connected(b, 1));
  a.made[0].stats = [
    { type: 'remote-inbound-rtp', kind: 'video', fractionLost: 0.6, roundTripTime: 2 },
    ...richStats(0, 0).slice(1, 2),
  ];
  for (const t of [2000, 4000, 6000, 8000]) { a.clock.t = t; await a.room.call.adapt(); }
  const [row] = a.room.call.quality();
  assert.equal(row.send.loss, 0.6); // measured ...
  assert.equal(row.rung, 3); // ... but nothing to protect: untouched
  assert.equal(row.paused, false);
});

test('connections that share an uplink step down one at a time', async () => {
  const people = await party(3);
  await Promise.all(people.map((p) => p.room.call.join({ video: true })));
  await until(() => people.every((p) => connected(p, 2)));
  const [a] = people;
  const rungs = () => a.room.call.quality().map((r) => r.rung).sort();
  assert.deepEqual(rungs(), [3, 3]);
  for (const rtc of a.made) {
    rtc.stats = [
      { type: 'remote-inbound-rtp', kind: 'video', fractionLost: 0.08, roundTripTime: 0.05 },
    ];
  }
  const step = async (t) => { a.clock.t = t; await a.room.call.adapt(); };
  await step(4000); // one bad sample each: a blip
  assert.deepEqual(rungs(), [3, 3]);
  await step(6000); // both are due to step down: only one does
  assert.deepEqual(rungs(), [2, 3]);
  await step(8000); // the other one, now
  assert.deepEqual(rungs(), [2, 2]);
});
