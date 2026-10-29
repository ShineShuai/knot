// The speaking highlight: loudness, hold time, and the meter's bookkeeping, with a fake
// audio context (the real one needs a browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import { SPEAKING_LEVEL, SpeakingMeter, loudness } from '../src/call/speaking.js';
import { FakeAudio } from './call-fakes.js';

const audio = () => ({ kind: 'audio' });
const stream = (...tracks) => ({ getTracks: () => tracks });
const meterAt = () => {
  const clock = { ms: 0 };
  const stops = [];
  const meter = new SpeakingMeter({
    Context: FakeAudio, now: () => clock.ms, every: () => () => stops.push('stopped'),
  });
  return { clock, meter, stops };
};

test('loudness: silence is 0, a loud wave is high, quiet noise stays under the threshold', () => {
  assert.equal(loudness(new Uint8Array(64).fill(128)), 0);
  assert.ok(loudness(Uint8Array.from({ length: 64 }, (_, i) => (i % 2 ? 255 : 0))) > 0.9);
  assert.ok(loudness(Uint8Array.from({ length: 64 }, (_, i) => 128 + (i % 2 ? 2 : -2)))
    < SPEAKING_LEVEL);
  assert.equal(loudness(new Uint8Array(0)), 0);
});

test('someone is speaking while loud, and a moment after; then not', () => {
  FakeAudio.loud.clear();
  const { clock, meter } = meterAt();
  const voice = stream(audio());
  const changes = [];
  meter.on('change', () => changes.push([...meter.ids()].filter((id) => meter.isSpeaking(id))));
  meter.watch('bob', voice);
  meter.tick(100);
  assert.equal(meter.isSpeaking('bob'), false);

  FakeAudio.loud.add(voice);
  meter.tick(1000);
  assert.equal(meter.isSpeaking('bob'), true);
  FakeAudio.loud.delete(voice);
  meter.tick(1200); // still inside the hold time: no flicker between words
  assert.equal(meter.isSpeaking('bob'), true);
  meter.tick(1500);
  assert.equal(meter.isSpeaking('bob'), false);
  assert.deepEqual(changes, [['bob'], []]);
  assert.equal(clock.ms, 0);
});

test('streams: same track is one analyser, a new track replaces it, none is ignored', () => {
  const { meter } = meterAt();
  const [track1, track2] = [audio(), audio()];
  meter.watch('a', stream(track1));
  meter.watch('a', stream(track1));
  assert.equal(FakeAudio.last.sources, 1);
  meter.watch('a', stream(track2)); // the other side renegotiated
  assert.equal(FakeAudio.last.sources, 2);
  meter.watch('video-only', stream({ kind: 'video' }));
  assert.deepEqual(meter.ids(), ['a']);
});

test('unwatching a speaker ends the highlight; the last one stops the timer', () => {
  FakeAudio.loud.clear();
  const { meter, stops } = meterAt();
  const voice = stream(audio());
  meter.watch('a', voice);
  FakeAudio.loud.add(voice);
  meter.tick(10);
  let changed = 0;
  meter.on('change', () => changed++);
  meter.unwatch('a');
  assert.equal(meter.isSpeaking('a'), false);
  assert.equal(changed, 1);
  assert.deepEqual(stops, ['stopped']);
  meter.unwatch('a'); // nothing left: no error
});

test('stop releases the audio context; a browser without one just does nothing', () => {
  const { meter } = meterAt();
  meter.watch('a', stream(audio()));
  const ctx = FakeAudio.last;
  meter.stop();
  assert.equal(ctx.closed, true);
  assert.deepEqual(meter.ids(), []);

  const none = new SpeakingMeter({ Context: null });
  assert.equal(none.supported, false);
  none.watch('a', stream(audio()));
  none.tick(5);
  assert.deepEqual(none.ids(), []);
  none.stop();

  class Broken extends FakeAudio { createMediaStreamSource() { throw new Error('no'); } }
  const odd = new SpeakingMeter({ Context: Broken, every: () => () => {} });
  odd.watch('a', stream(audio())); // cannot analyse it: no highlight, no crash
  assert.deepEqual(odd.ids(), []);
});
