import { ScraperError } from '../errors.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Per-host outbound throttle. Guarantees a minimum gap (plus jitter) between upstream
 * requests to the same host, caps concurrency, bounds the queue, and supports a cooldown
 * ("circuit breaker") after the upstream blocks us.
 */
export class RateLimiter {
  constructor({
    getMinIntervalMs,
    jitterMs = 0,
    concurrency = 1,
    maxQueue = 25,
    maxWaitMs = 120000,
    cooldownMs = 300000,
    now = Date.now,
    random = Math.random,
    logger,
  }) {
    this.getMinIntervalMs = getMinIntervalMs;
    this.jitterMs = jitterMs;
    this.concurrency = concurrency;
    this.maxQueue = maxQueue;
    this.maxWaitMs = maxWaitMs;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.random = random;
    this.logger = logger;
    this.hosts = new Map();
  }

  #state(key) {
    let s = this.hosts.get(key);
    if (!s) {
      s = { active: 0, queue: [], lastTouch: 0, gap: 0, blockedUntil: 0, timer: null };
      this.hosts.set(key, s);
    }
    return s;
  }

  #blockedError(s) {
    const seconds = (s.blockedUntil - this.now()) / 1000;
    return new ScraperError(
      'UPSTREAM_BLOCKED',
      `The search engine recently blocked this machine; requests are paused for ${Math.ceil(seconds)}s to avoid making it worse.`,
      { retryAfter: seconds },
    );
  }

  /** Run `task` once the host's rate limit allows it. */
  run(key, task) {
    const s = this.#state(key);
    if (s.blockedUntil > this.now()) return Promise.reject(this.#blockedError(s));
    if (s.queue.length >= this.maxQueue) {
      return Promise.reject(
        new ScraperError('RATE_LIMITED', 'Too many searches are queued; try again shortly.', {
          retryAfter: Math.max(1, ((this.getMinIntervalMs() + this.jitterMs) * s.queue.length) / 1000),
        }),
      );
    }
    return new Promise((resolve, reject) => {
      s.queue.push({ task, resolve, reject, enqueuedAt: this.now() });
      this.#pump(key);
    });
  }

  /** Pause all requests to `key` (e.g. after a CAPTCHA or HTTP 429). */
  block(key, ms = this.cooldownMs, reason = 'blocked') {
    const s = this.#state(key);
    s.blockedUntil = Math.max(s.blockedUntil, this.now() + ms);
    this.logger?.warn('Upstream host blocked; entering cooldown', { host: key, cooldownMs: ms, reason });
  }

  unblock(key) {
    this.#state(key).blockedUntil = 0;
  }

  #pump(key) {
    const s = this.#state(key);
    while (s.active < this.concurrency && s.queue.length) {
      const now = this.now();
      if (s.blockedUntil > now) {
        const err = this.#blockedError(s);
        for (const job of s.queue.splice(0)) job.reject(err);
        return;
      }
      const wait = s.lastTouch + s.gap - now;
      if (wait > 0) {
        if (!s.timer) {
          s.timer = setTimeout(() => {
            s.timer = null;
            this.#pump(key);
          }, wait);
          s.timer.unref?.();
        }
        return;
      }
      const job = s.queue.shift();
      if (now - job.enqueuedAt > this.maxWaitMs) {
        job.reject(new ScraperError('RATE_LIMITED', 'Timed out waiting in the rate-limit queue.', { retryAfter: 5 }));
        continue;
      }
      s.active++;
      s.lastTouch = now;
      s.gap = this.getMinIntervalMs() + this.random() * this.jitterMs;
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => {
          s.active--;
          s.lastTouch = this.now();
          this.#pump(key);
        });
    }
  }

  status() {
    const hosts = {};
    for (const [host, s] of this.hosts) {
      hosts[host] = {
        active: s.active,
        queued: s.queue.length,
        blockedForSeconds: Math.max(0, Math.ceil((s.blockedUntil - this.now()) / 1000)),
      };
    }
    return { minIntervalMs: this.getMinIntervalMs(), hosts };
  }
}

export { sleep };
