import { ScraperError } from '../errors.js';
import type { Logger } from '../logger.js';

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface RateLimiterOptions {
  getMinIntervalMs: () => number;
  jitterMs?: number;
  concurrency?: number;
  maxQueue?: number;
  maxWaitMs?: number;
  cooldownMs?: number;
  now?: () => number;
  random?: () => number;
  logger?: Logger;
}

interface Job {
  task: () => unknown;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  enqueuedAt: number;
}

interface HostState {
  active: number;
  queue: Job[];
  lastTouch: number;
  gap: number;
  blockedUntil: number;
  timer: NodeJS.Timeout | null;
}

export interface RateLimiterStatus {
  minIntervalMs: number;
  hosts: Record<string, { active: number; queued: number; blockedForSeconds: number }>;
}

/**
 * Per-host outbound throttle. Guarantees a minimum gap (plus jitter) between upstream
 * requests to the same host, caps concurrency, bounds the queue, and supports a cooldown
 * ("circuit breaker") after the upstream blocks us.
 */
export class RateLimiter {
  private readonly getMinIntervalMs: () => number;
  private readonly jitterMs: number;
  private readonly concurrency: number;
  private readonly maxQueue: number;
  private readonly maxWaitMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly logger: Logger | undefined;
  private readonly hosts = new Map<string, HostState>();

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
  }: RateLimiterOptions) {
    this.getMinIntervalMs = getMinIntervalMs;
    this.jitterMs = jitterMs;
    this.concurrency = concurrency;
    this.maxQueue = maxQueue;
    this.maxWaitMs = maxWaitMs;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.random = random;
    this.logger = logger;
  }

  #state(key: string): HostState {
    let s = this.hosts.get(key);
    if (!s) {
      s = { active: 0, queue: [], lastTouch: 0, gap: 0, blockedUntil: 0, timer: null };
      this.hosts.set(key, s);
    }
    return s;
  }

  #blockedError(s: HostState): ScraperError {
    const seconds = (s.blockedUntil - this.now()) / 1000;
    return new ScraperError(
      'UPSTREAM_BLOCKED',
      `The search engine recently blocked this machine; requests are paused for ${Math.ceil(seconds)}s to avoid making it worse.`,
      { retryAfter: seconds },
    );
  }

  /** Run `task` once the host's rate limit allows it. */
  run<T>(key: string, task: () => T | Promise<T>): Promise<T> {
    const s = this.#state(key);
    if (s.blockedUntil > this.now()) return Promise.reject(this.#blockedError(s));
    if (s.queue.length >= this.maxQueue) {
      return Promise.reject(
        new ScraperError('RATE_LIMITED', 'Too many searches are queued; try again shortly.', {
          retryAfter: Math.max(1, ((this.getMinIntervalMs() + this.jitterMs) * s.queue.length) / 1000),
        }),
      );
    }
    return new Promise<T>((resolve, reject) => {
      s.queue.push({ task, resolve: resolve as Job['resolve'], reject, enqueuedAt: this.now() });
      this.#pump(key);
    });
  }

  /** Pause all requests to `key` (e.g. after a CAPTCHA or HTTP 429). */
  block(key: string, ms = this.cooldownMs, reason = 'blocked'): void {
    const s = this.#state(key);
    s.blockedUntil = Math.max(s.blockedUntil, this.now() + ms);
    this.logger?.warn('Upstream host blocked; entering cooldown', { host: key, cooldownMs: ms, reason });
  }

  unblock(key: string): void {
    this.#state(key).blockedUntil = 0;
  }

  #pump(key: string): void {
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
      if (!job) return;
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

  status(): RateLimiterStatus {
    const hosts: RateLimiterStatus['hosts'] = {};
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

