// Video quality policy for one call, as plain functions (no browser, easy to test).
//
// Goals, in order: audio never suffers; video stays smooth (steady frame rate, few quality
// jumps, no queueing, so no added delay); then as sharp as the network and the screen allow.
// The browser already adapts on its own; this module keeps it from having to, by picking a
// stable operating point (resolution, frame rate, bitrate cap) per connection:
//
//   ceiling  = min(what the head count allows, what the receiver's tile can show)
//   level    = what this connection has proven it can carry (slow up, fast down)
//   rung     = min(level, ceiling); rung 0 means "no video" (audio only)

/** Rungs per kind of video; index 0 is "off". `h`: height in pixels, `bps`: bitrate cap. */
export const LADDER = {
  camera: [
    null,
    { h: 180, fps: 15, bps: 100_000 },
    { h: 270, fps: 24, bps: 250_000 },
    { h: 360, fps: 30, bps: 500_000 },
    { h: 540, fps: 30, bps: 1_000_000 },
    { h: 720, fps: 30, bps: 1_800_000 },
  ],
  // Text and slides: resolution matters, frame rate does not.
  screen: [
    null,
    { h: 540, fps: 5, bps: 200_000 },
    { h: 720, fps: 8, bps: 500_000 },
    { h: 1080, fps: 10, bps: 1_000_000 },
    { h: 1080, fps: 15, bps: 1_800_000 },
  ],
};

/** What to give up first when the network cannot keep up. */
export const DEGRADATION = { camera: 'maintain-framerate', screen: 'maintain-resolution' };

export const MAX_WANT = 4320; // the tallest tile height (pixels) a peer may ask for

export const topRung = (kind) => LADDER[kind].length - 1;

/** Every sender encodes once per receiver, so more people means a lower ceiling each. */
export const rungByPeople = (kind, people) => Math.max(
  kind === 'screen' ? 1 : 2, topRung(kind) - Math.max(0, people - 2),
);

/** The lowest rung that is at least `h` pixels tall (the top one for the tallest sizes, so
 *  its higher frame rate is not cut off). */
export function rungFor(kind, h) {
  if (!(h > 0)) return 0;
  const ladder = LADDER[kind];
  const top = ladder.length - 1;
  if (h >= ladder[top].h) return top;
  for (let i = 1; i < top; i++) if (ladder[i].h >= h) return i;
  return top;
}

/** Highest rung worth sending: `want` is the receiver's tile height in pixels (0: not
 *  shown), or undefined while it has not said. */
export function ceiling(kind, people, want) {
  const byPeople = rungByPeople(kind, people);
  return want === undefined ? byPeople : Math.min(byPeople, rungFor(kind, want));
}

/** Encoder settings for a rung (rung 0: `{ active: false }`). */
export function profileOf(kind, rung) {
  const step = LADDER[kind][rung];
  return step ? { active: true, kind, ...step } : { active: false, kind };
}

/** Receiver side: tile height in CSS pixels -> the height to ask for (0: not visible). */
const WANT_STEPS = [180, 270, 360, 540, 720, 1080];
export function wantHeight(cssHeight, ratio = 1) {
  if (!(cssHeight >= 40)) return 0; // collapsed or hidden tile
  const pixels = cssHeight * (ratio > 0 ? ratio : 1);
  return WANT_STEPS.find((step) => step >= pixels) ?? WANT_STEPS.at(-1);
}

/** A valid `want` from the wire, or undefined. */
export const parseWant = (h) => (Number.isInteger(h) && h >= 0 && h <= MAX_WANT ? h : undefined);

// ---- statistics ---------------------------------------------------------------------------

/**
 * Reduce an RTCStatsReport (anything with forEach) to what the controller uses. Every field
 * may be null: browsers differ in what they report, and the controller copes with that.
 *   bytes, ts   video bytes sent and when;  loss  fraction lost (0..1);  rtt  seconds
 *   limit       why the encoder holds back ('bandwidth' | 'cpu' | 'none'), Chromium only
 *   available   the browser's estimate of the sendable bitrate, bits/s, Chromium only
 */
export function readStats(report) {
  const out = {
    bytes: null, ts: null, loss: null, rtt: null, limit: null, available: null,
  };
  report.forEach((s) => {
    const kind = s.kind ?? s.mediaType;
    if (s.type === 'outbound-rtp' && kind === 'video') {
      out.bytes = (out.bytes ?? 0) + (s.bytesSent ?? 0);
      out.ts = s.timestamp ?? out.ts;
      out.limit = s.qualityLimitationReason ?? out.limit;
    } else if (s.type === 'remote-inbound-rtp' && kind === 'video') {
      if (typeof s.fractionLost === 'number') out.loss = s.fractionLost;
      if (typeof s.roundTripTime === 'number') out.rtt = s.roundTripTime;
    } else if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') {
      if (typeof s.availableOutgoingBitrate === 'number') {
        out.available = s.availableOutgoingBitrate;
      }
      if (out.rtt === null && typeof s.currentRoundTripTime === 'number') {
        out.rtt = s.currentRoundTripTime;
      }
    }
  });
  return out;
}

// ---- the controller -----------------------------------------------------------------------

const LOSS_BAD = 0.05;       // this much loss for two samples in a row: step down
const LOSS_SEVERE = 0.15;    // this much: step down by two, at once
const RTT_SEVERE = 1.0;      // seconds
const RTT_FLOOR = 0.4;       // a queue shows as delay: bad above max(this, 3 x the best seen)
const WARM_SAMPLES = 3;      // the browser's own estimate needs a few seconds to settle
const DOWN_DWELL_MS = 3000;  // after any move, wait this long before stepping down again
const UP_MS = 8000;          // calm time needed before trying one rung up
const UP_MAX_MS = 60_000;    // ... which doubles (up to this) after a try that did not hold
const FAILED_UP_MS = 20_000; // a step down this soon after a step up means the try failed
const PROBE_MS = 15_000;     // minimum pause before video is tried again after it was dropped
const FIT_DOWN = 0.7;        // the estimate is below this share of the rung's cap: too much
const FIT_UP = 1.3;          // the estimate must exceed the next rung's cap by this much
const START = { camera: 3, screen: 2 };

/**
 * One connection's health, turned into a rung. Feed it one sample every couple of seconds
 * (`update`); it moves down quickly on trouble and up slowly, one rung at a time, and gives
 * up video (rung 0) only when even the lowest rung does not fit.
 */
export class LinkQuality {
  #rtts = [];
  #bad = 0;
  #samples = 0;
  #goodSince = null;
  #lastUp = null;
  #hold = UP_MS;
  #changedAt;

  constructor(kind, at = 0) {
    this.kind = kind;
    this.level = Math.min(START[kind], topRung(kind));
    this.#changedAt = at;
  }

  /** The rung to send now without a new measurement (the ceiling or the capture changed). */
  rung(ceil) { return ceil <= 0 ? 0 : Math.min(this.level, ceil); }

  /** The rung to send now, given the latest `sample` (see readStats) and the ceiling. */
  update(sample, ceil, at) {
    if (ceil <= 0) { // the receiver does not show us: nothing to measure, nothing to send
      this.#bad = 0;
      this.#goodSince = null;
      return 0;
    }
    const rung = Math.min(this.level, ceil);
    if (rung === 0) return this.#probe(ceil, at);

    this.#samples++;
    const { loss = 0, rtt, limit, available } = sample ?? {};
    if (rtt != null) {
      this.#rtts.push(rtt);
      if (this.#rtts.length > 30) this.#rtts.shift();
    }
    const base = this.#rtts.length ? Math.min(...this.#rtts) : null;
    const cap = LADDER[this.kind][rung].bps;
    const severe = (loss ?? 0) >= LOSS_SEVERE || (rtt != null && rtt > RTT_SEVERE);
    const bad = severe
      || (loss ?? 0) > LOSS_BAD
      || (rtt != null && base != null && rtt > Math.max(RTT_FLOOR, 3 * base))
      || limit === 'bandwidth' || limit === 'cpu'
      || (this.#samples > WARM_SAMPLES && available != null && available < FIT_DOWN * cap);

    if (bad) {
      this.#goodSince = null;
      this.#bad++;
      if ((severe || this.#bad >= 2) && at - this.#changedAt >= DOWN_DWELL_MS) {
        this.#move(Math.max(0, rung - (severe ? 2 : 1)), at);
        this.#bad = 0;
      }
    } else {
      this.#bad = 0;
      this.#goodSince ??= at;
      const next = LADDER[this.kind][rung + 1];
      const roomAbove = rung < ceil && next
        && (available == null || available >= FIT_UP * next.bps);
      if (roomAbove && at - this.#goodSince >= this.#hold && at - this.#changedAt >= this.#hold) {
        this.#move(rung + 1, at);
      }
      if (at - this.#changedAt >= UP_MAX_MS) this.#hold = UP_MS; // long calm: forget the penalty
    }
    return Math.min(this.level, ceil);
  }

  /** Video was dropped for the network: try the lowest rung again after a pause. */
  #probe(ceil, at) {
    if (at - this.#changedAt >= Math.max(this.#hold, PROBE_MS)) this.#move(1, at);
    return Math.min(this.level, ceil);
  }

  #move(level, at) {
    const up = level > this.level;
    if (!up && this.#lastUp != null && at - this.#lastUp < FAILED_UP_MS) {
      this.#hold = Math.min(this.#hold * 2, UP_MAX_MS); // that try did not hold: wait longer
    }
    if (up) this.#lastUp = at;
    this.level = level;
    this.#changedAt = at;
    this.#goodSince = at;
  }
}
