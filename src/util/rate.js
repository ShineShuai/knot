// Token-bucket limiter: allow() is false once `perSec` events were used up.
export class RateLimiter {
  #tokens; #last; #perSec; #now;
  constructor(perSec, now = Date.now) {
    this.#perSec = perSec; this.#tokens = perSec; this.#now = now; this.#last = now();
  }
  allow() {
    const t = this.#now();
    this.#tokens = Math.min(this.#perSec, this.#tokens + ((t - this.#last) / 1000) * this.#perSec);
    this.#last = t;
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}
