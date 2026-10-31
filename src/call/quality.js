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
 * Reduce an RTCStatsReport (anything with forEach) to what the controller and the diagnostics
 * use. Every field may be null: browsers differ in what they report, and the controller
 * copes with that.
 *   bytes, ts   video bytes sent and when;  fps, w, h  what the encoder produces
 *   loss        fraction lost (0..1);  rtt  seconds
 *   limit       why the encoder holds back ('bandwidth' | 'cpu' | 'none'), Chromium only
 *   available   the browser's estimate of the sendable bitrate, bits/s, Chromium only
 *   recv        the video we receive from the same peer: { fps, w, h, freezes } or null
 */
export function readStats(report) {
  const out = {
    bytes: null, ts: null, fps: null, w: null, h: null, loss: null, rtt: null, limit: null,
    available: null, recv: null,
  };
  const number = (x) => (typeof x === 'number' ? x : null);
  report.forEach((s) => {
    const kind = s.kind ?? s.mediaType;
    if (s.type === 'outbound-rtp' && kind === 'video') {
      out.bytes = (out.bytes ?? 0) + (s.bytesSent ?? 0);
      out.ts = s.timestamp ?? out.ts;
      out.limit = s.qualityLimitationReason ?? out.limit;
      out.fps = number(s.framesPerSecond) ?? out.fps;
      out.w = number(s.frameWidth) ?? out.w;
      out.h = number(s.frameHeight) ?? out.h;
    } else if (s.type === 'inbound-rtp' && kind === 'video') {
      out.recv = {
        fps: number(s.framesPerSecond), w: number(s.frameWidth), h: number(s.frameHeight),
        freezes: number(s.freezeCount),
      };
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

/** Bits per second sent between two samples (null if the browser gave no byte counts).
 *  `seconds`: the time between them, used when the samples carry no timestamps. */
export function bitrate(prev, cur, seconds) {
  if (prev?.bytes == null || cur?.bytes == null) return null;
  const dt = prev.ts != null && cur.ts != null ? (cur.ts - prev.ts) / 1000 : seconds;
  return dt > 0 ? (Math.max(0, cur.bytes - prev.bytes) * 8) / dt : null;
}

// ---- the controller -----------------------------------------------------------------------

const LOSS_BAD = 0.05;       // this much loss for two samples in a row: step down
const LOSS_SEVERE = 0.15;    // this much: step down by two, at once
const RTT_SEVERE = 1.0;      // seconds
const RTT_FLOOR = 0.4;       // a queue shows as delay: bad above max(this, 3 x the best seen)
const WARM_SAMPLES = 3;      // the browser's own estimate needs a few seconds to settle
const DOWN_DWELL_MS = 3000;  // after any move, wait this long before stepping down again
const UP_MS = 8000;          // calm time needed before trying one rung up
const FAILED_UP_MS = 20_000; // a step down this soon after a step up means the try failed
const RETRY_MS = 45_000;     // a rung we had to leave is not tried again for this long ...
const BLOCK_MS = 90_000;     // ... and for this long if it failed right after we climbed to it,
const BLOCK_MAX_MS = 180_000; // doubling with every repeat, up to this
const SETTLED_MS = 60_000;   // staying this long at a rung makes it trusted again
const PROBE_MS = 15_000;     // pause before video is tried again after it was dropped ...
const PROBE_MAX_MS = 60_000; // ... doubled (up to this) while each try fails again
const FIT_DOWN = 0.7;        // the estimate is below this share of the rung's cap: too much
const SHRUNK = 0.8;          // the encoder makes less than this share of the height we asked
const FIT_AIR = 1.15;        // to climb, the estimate must exceed what we send by this much
const FIT_UP = 1.3;          // an estimate this far above the next rung's cap: climb sooner
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
  #probeWait = PROBE_MS;
  #failed = new Map(); // rung -> { until, n }: not tried again before `until` (n failures)
  #changedAt;

  constructor(kind, at = 0) {
    this.kind = kind;
    this.level = Math.min(START[kind], topRung(kind));
    this.#changedAt = at;
  }

  /** The rung to send now without a new measurement (the ceiling or the capture changed). */
  rung(ceil) { return ceil <= 0 ? 0 : Math.min(this.level, ceil); }

  /** Would this sample count as trouble? (Changes nothing: lets a group decide who moves.) */
  assess(sample, ceil) {
    const rung = this.rung(ceil);
    return rung === 0
      ? { bad: false, severe: false }
      : this.#judge(sample, rung, this.#samples + 1);
  }

  #judge(sample, rung, samples) {
    const { loss, rtt, limit, available } = sample ?? {};
    const base = Math.min(...this.#rtts, rtt ?? Infinity);
    const lost = loss ?? 0;
    const severe = lost >= LOSS_SEVERE || (rtt != null && rtt > RTT_SEVERE);
    const queued = rtt != null && rtt > Math.max(RTT_FLOOR, 3 * base);
    const tooMuch = samples > WARM_SAMPLES && available != null
      && available < FIT_DOWN * LADDER[this.kind][rung].bps;
    // Chromium says so; elsewhere the picture shows it: a camera whose browser makes smaller
    // frames than we asked for is being throttled. (Frame rate is no sign: dim rooms and still
    // screens lower it for good reasons.)
    const shrunk = this.kind === 'camera' && sample?.h != null
      && sample.h < SHRUNK * LADDER.camera[rung].h;
    const held = limit === 'bandwidth' || limit === 'cpu' || shrunk;
    return { bad: severe || lost > LOSS_BAD || queued || held || tooMuch, severe };
  }

  /**
   * The rung to send now, given the latest `sample` (see readStats) and the ceiling.
   * `drop: false` / `climb: false` hold back a step down / up that is due (a group takes
   * turns so that connections sharing an uplink do not all move at once); severe trouble
   * always acts.
   */
  update(sample, ceil, at, { drop = true, climb = true } = {}) {
    if (ceil <= 0) { // the receiver does not show us: nothing to measure, nothing to send
      this.#bad = 0;
      this.#goodSince = null;
      return 0;
    }
    const rung = Math.min(this.level, ceil);
    if (rung === 0) return this.#probe(ceil, at);

    this.#samples++;
    const { bad, severe } = this.#judge(sample, rung, this.#samples);
    if (sample?.rtt != null) {
      this.#rtts.push(sample.rtt);
      if (this.#rtts.length > 30) this.#rtts.shift();
    }

    if (bad) {
      this.#goodSince = null;
      this.#bad++;
      const due = severe || this.#bad >= 2;
      if (due && (severe || drop) && at - this.#changedAt >= DOWN_DWELL_MS) {
        this.#move(Math.max(0, rung - (severe ? 2 : 1)), at, rung);
        this.#bad = 0;
      }
    } else {
      this.#bad = 0;
      this.#goodSince ??= at;
      const { available } = sample ?? {};
      const next = LADDER[this.kind][rung + 1];
      // The estimate only has to leave air above what we send now (it often cannot say more
      // while we send little); a clear margin for the next rung shortens the wait.
      const air = available == null || available >= FIT_AIR * LADDER[this.kind][rung].bps;
      const clear = available != null && next && available >= FIT_UP * next.bps;
      const wait = clear ? UP_MS / 2 : UP_MS;
      const calm = at - this.#goodSince >= wait && at - this.#changedAt >= wait;
      const known = (this.#failed.get(rung + 1)?.until ?? 0) > at && !clear;
      if (at - this.#changedAt >= SETTLED_MS) {
        for (const r of this.#failed.keys()) if (r <= rung) this.#failed.delete(r);
      }
      if (rung < ceil && next && air && climb && calm && !known) this.#move(rung + 1, at, rung);
    }
    return Math.min(this.level, ceil);
  }

  /** Video was dropped for the network: try the lowest rung again after a pause. */
  #probe(ceil, at) {
    if (at - this.#changedAt >= this.#probeWait) this.#move(1, at, 0);
    return Math.min(this.level, ceil);
  }

  /** Change the level; `from`: the rung we were sending at. */
  #move(level, at, from) {
    const up = level > this.level;
    if (up) {
      // The previous climb has held for a while: forgive earlier failed probes of video.
      if (this.level > 0 && this.#lastUp != null && at - this.#lastUp >= FAILED_UP_MS) {
        this.#probeWait = PROBE_MS;
      }
      this.#lastUp = at;
    } else {
      const quick = this.#lastUp != null && at - this.#lastUp < FAILED_UP_MS;
      for (let r = level + 1; r <= from; r++) {
        const n = (this.#failed.get(r)?.n ?? 0) + 1;
        const wait = Math.min((quick ? BLOCK_MS : RETRY_MS) * 2 ** (n - 1), BLOCK_MAX_MS);
        this.#failed.set(r, { until: at + wait, n });
      }
      if (level === 0 && quick) this.#probeWait = Math.min(this.#probeWait * 2, PROBE_MAX_MS);
    }
    this.level = level;
    this.#changedAt = at;
    this.#goodSince = at;
  }
}

const CLIMB_GAP_MS = 4000; // at most one connection starts a climb in this time

/**
 * The connections of one call, which share one uplink. Every sender encodes once per peer, so
 * when several connections suffer at once it is the uplink, and each stepping down on its
 * own would over-correct and then climb back together. The group lets one connection step
 * down per review (the one whose tile is smallest, then the heaviest stream) and one climb at
 * a time, and only while nothing suffers. Severe trouble is not held back.
 */
export class QualityGroup {
  #lastClimb = -Infinity;

  /** `items`: [{ q, sample, ceil, want }] (`want`: tile height asked for, undefined: unknown).
   *  Returns the rung for each item, in order. */
  review(items, at) {
    const states = items.map(({ q, sample, ceil }) => q.assess(sample, ceil));
    const suffering = states.filter((x) => x.bad).length;
    const climb = suffering === 0 && at - this.#lastClimb >= CLIMB_GAP_MS;
    const order = items.map((_, i) => i).sort((x, y) => (
      (items[x].want ?? MAX_WANT) - (items[y].want ?? MAX_WANT)
      || items[y].q.rung(items[y].ceil) - items[x].q.rung(items[x].ceil)
    ));
    const rungs = [];
    let dropped = false;
    let climbed = false;
    for (const i of order) {
      const { q, sample, ceil } = items[i];
      const before = q.level;
      rungs[i] = q.update(sample, ceil, at, {
        drop: suffering < 2 || !dropped, climb: climb && !climbed,
      });
      if (q.level < before) dropped = true;
      if (q.level > before) { climbed = true; this.#lastClimb = at; }
    }
    return rungs;
  }
}
