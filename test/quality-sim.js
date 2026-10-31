// A small, deterministic model of one sender whose uplink carries every connection of a call,
// used to check (and tune) the quality controller against network traces, with no browser.
//
// It is a model, not a measurement: the sender's own bandwidth estimate follows the capacity
// with a lag and overshoots a little; a link that carries more than its capacity builds a
// queue (delay) and then loses packets. What it can show is how the controller behaves: how
// fast it settles, whether it flaps, and how long the link is overloaded. What it cannot show
// is how a real browser, router or radio behaves: validate on real networks as well
// (tools/netshape.sh).
import {
  LADDER, LinkQuality, QualityGroup, ceiling, topRung,
} from '../src/call/quality.js';

const STEP = 0.5;       // seconds per model step
const REVIEW_STEPS = 4; // the controller sees a sample every 2 s, like the call does
const BUFFER_S = 0.5;   // queueing delay at which the bottleneck starts to drop packets

/**
 * capacity(t)  uplink bits/s at second t
 * links        connections (one per other person)
 * estimate     what the browser reports as availableOutgoingBitrate:
 *              'none' (Firefox/Safari), 'limited' (stays near 1.5x what is sent) or 'probing'
 * limitSignal  report qualityLimitationReason (Chromium)
 * group        take turns stepping (QualityGroup) instead of every link on its own
 * want         tile height each receiver shows (undefined: not told)
 */
export function simulate({
  capacity, kind = 'camera', links = 1, seconds = 180, estimate = 'none', limitSignal = false,
  group = true, want, rtt0 = 0.04,
}) {
  const people = links + 1;
  const ceil = ceiling(kind, people, want);
  const qs = Array.from({ length: links }, () => new LinkQuality(kind, 0));
  const bwe = qs.map(() => 300_000);
  const rate = qs.map(() => 0);
  const rungs = qs.map((q) => q.rung(ceil));
  const guard = new QualityGroup();
  const log = { rungs: [], changes: [], overload: 0, lossy: 0, paused: 0, sent: [] };
  let queue = 0;
  let loss = 0;
  // The browser throttles on its own when its estimate is low: smaller frames for the rate.
  const madeHeight = (i) => {
    const fits = LADDER[kind].filter((x, r) => x && r <= rungs[i] && x.bps * 0.9 <= bwe[i]);
    return fits.length ? fits.at(-1).h : Math.round(LADDER[kind][1].h / 2);
  };

  for (let step = 0; step < (seconds / STEP); step++) {
    const t = step * STEP;
    const cap = capacity(t);
    for (let i = 0; i < links; i++) {
      const step_ = LADDER[kind][rungs[i]];
      rate[i] = step_ ? Math.min(step_.bps * 0.9, bwe[i]) : 0; // an encoder rarely fills its cap
    }
    const total = rate.reduce((a, b) => a + b, 0);
    const ratio = total > cap ? cap / total : 1;
    queue = total > cap ? Math.min(BUFFER_S * 2, queue + ((total - cap) / cap) * STEP)
      : Math.max(0, queue - 0.5 * STEP);
    loss = total > cap && queue >= BUFFER_S ? 1 - ratio : 0;
    const live = Math.max(1, rungs.filter((r) => r > 0).length);
    for (let i = 0; i < links; i++) {
      // What a link's estimator settles on: what the others leave of the capacity (at least
      // a fair share's worth, so a link is never starved by the others).
      const share = Math.max(cap / (2 * live), cap - (total - rate[i]));
      if (rungs[i] === 0) { bwe[i] = Math.min(bwe[i] * 1.08 ** STEP, share); continue; }
      const delivered = rate[i] * (1 - loss);
      if (queue > 0.05 || loss > 0.02) {
        bwe[i] = Math.max(30_000, Math.min(bwe[i], 0.85 * delivered));
      } else {
        const appLimited = estimate === 'limited' ? 1.5 * delivered + 10_000 : Infinity;
        const reach = Math.min(1.05 * share, appLimited);
        bwe[i] = Math.min(bwe[i] * 1.12 ** STEP, Math.max(bwe[i], reach));
      }
    }
    if (queue > 0.1) log.overload += STEP;
    if (loss > 0.02) log.lossy += STEP;
    if (rungs.every((r) => r === 0)) log.paused += STEP;
    log.sent.push(total);
    log.rungs.push([...rungs]);

    if ((step + 1) % REVIEW_STEPS === 0) {
      const at = (t + STEP) * 1000;
      const items = qs.map((q, i) => ({
        q, ceil, want,
        sample: {
          loss: rungs[i] ? loss : null, rtt: rtt0 + queue, h: rungs[i] ? madeHeight(i) : null,
          limit: limitSignal && rungs[i] && LADDER[kind][rungs[i]].bps * 0.9 > bwe[i] * 1.0
            ? 'bandwidth' : 'none',
          available: estimate === 'none' ? null : bwe[i],
        },
      }));
      const next = group ? guard.review(items, at)
        : items.map(({ q, sample }) => q.update(sample, ceil, at));
      next.forEach((rung, i) => {
        if (rung !== rungs[i]) log.changes.push({ t: t + STEP, link: i, from: rungs[i], to: rung });
        rungs[i] = rung;
      });
    }
  }
  return { ...log, top: topRung(kind), ceil };
}

/** Rung changes after `after` seconds (settling is allowed to take a while). */
export const flaps = (run, after = 40) => run.changes.filter((c) => c.t > after).length;
/** The rung of link `i` at second `t`. */
export const rungAt = (run, t, i = 0) => run.rungs[Math.round(t / STEP)][i];
