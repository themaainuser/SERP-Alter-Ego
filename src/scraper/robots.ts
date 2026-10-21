import robotsParserModule from 'robots-parser';
import type { Logger } from '../logger.js';
import type { HttpResponse } from './httpFetcher.js';

// robots-parser is CommonJS (`module.exports = fn`) but its bundled typings declare an ES default export,
// which NodeNext resolves to the module object. Pin the real call signature here.
interface Robot {
  isAllowed(url: string, userAgent?: string): boolean | undefined;
}
const robotsParser = robotsParserModule as unknown as (url: string, robotsTxt: string) => Robot;

type Rules = { status: 'rules'; parser: Robot } | { status: 'allow-all' } | { status: 'unavailable'; reason: string };
interface CacheEntry {
  promise: Promise<Rules>;
  expires: number;
}

export type RobotsCheck =
  | { status: 'allowed' }
  | { status: 'disallowed' }
  | { status: 'unavailable'; reason: string };

export interface RobotsCheckerOptions {
  fetchText: (url: string) => Promise<Pick<HttpResponse, 'status' | 'body'>>;
  userAgent: string;
  ttlMs?: number;
  failTtlMs?: number;
  now?: () => number;
  logger?: Logger;
}

/**
 * Fetches, caches and evaluates robots.txt per origin (RFC 9309 semantics):
 *  - 2xx  -> parse and apply the rules
 *  - 4xx  -> no robots.txt, everything allowed
 *  - 5xx / network failure -> "unavailable" (callers decide whether to proceed)
 */
export class RobotsChecker {
  private readonly fetchText: RobotsCheckerOptions['fetchText'];
  private readonly userAgent: string;
  private readonly ttlMs: number;
  private readonly failTtlMs: number;
  private readonly now: () => number;
  private readonly logger: Logger | undefined;
  private readonly cache = new Map<string, CacheEntry>();

  constructor({ fetchText, userAgent, ttlMs = 3600000, failTtlMs = 60000, now = Date.now, logger }: RobotsCheckerOptions) {
    this.fetchText = fetchText;
    this.userAgent = userAgent;
    this.ttlMs = ttlMs;
    this.failTtlMs = failTtlMs;
    this.now = now;
    this.logger = logger;
  }

  async check(url: string): Promise<RobotsCheck> {
    const { origin } = new URL(url);
    let entry = this.cache.get(origin);
    if (!entry || entry.expires <= this.now()) {
      const fresh: CacheEntry = { promise: this.#load(origin), expires: Infinity };
      entry = fresh;
      this.cache.set(origin, fresh);
      void fresh.promise.then((r) => {
        fresh.expires = this.now() + (r.status === 'unavailable' ? this.failTtlMs : this.ttlMs);
      });
    }
    const rules = await entry.promise;
    if (rules.status === 'unavailable') return { status: 'unavailable', reason: rules.reason };
    if (rules.status === 'allow-all') return { status: 'allowed' };
    const allowed = rules.parser.isAllowed(url, this.userAgent);
    return { status: allowed === false ? 'disallowed' : 'allowed' };
  }

  async #load(origin: string): Promise<Rules> {
    const robotsUrl = `${origin}/robots.txt`;
    try {
      const res = await this.fetchText(robotsUrl);
      if (res.status >= 200 && res.status < 300) {
        return { status: 'rules', parser: robotsParser(robotsUrl, res.body) };
      }
      if (res.status >= 400 && res.status < 500) return { status: 'allow-all' };
      return { status: 'unavailable', reason: `HTTP ${res.status}` };
    } catch (err) {
      this.logger?.warn('robots.txt fetch failed', { robotsUrl, error: err });
      return { status: 'unavailable', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  clear(): void {
    this.cache.clear();
  }
}
