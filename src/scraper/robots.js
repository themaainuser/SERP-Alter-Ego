import robotsParser from 'robots-parser';

/**
 * Fetches, caches and evaluates robots.txt per origin (RFC 9309 semantics):
 *  - 2xx  -> parse and apply the rules
 *  - 4xx  -> no robots.txt, everything allowed
 *  - 5xx / network failure -> "unavailable" (callers decide whether to proceed)
 */
export class RobotsChecker {
  constructor({ fetchText, userAgent, ttlMs = 3600000, failTtlMs = 60000, now = Date.now, logger }) {
    this.fetchText = fetchText;
    this.userAgent = userAgent;
    this.ttlMs = ttlMs;
    this.failTtlMs = failTtlMs;
    this.now = now;
    this.logger = logger;
    this.cache = new Map();
  }

  async check(url) {
    const { origin } = new URL(url);
    let entry = this.cache.get(origin);
    if (!entry || entry.expires <= this.now()) {
      entry = { promise: this.#load(origin), expires: Infinity };
      this.cache.set(origin, entry);
      entry.promise.then((r) => {
        entry.expires = this.now() + (r.status === 'unavailable' ? this.failTtlMs : this.ttlMs);
      });
    }
    const rules = await entry.promise;
    if (rules.status === 'unavailable') return { status: 'unavailable', reason: rules.reason };
    if (rules.status === 'allow-all') return { status: 'allowed' };
    const allowed = rules.parser.isAllowed(url, this.userAgent);
    return { status: allowed === false ? 'disallowed' : 'allowed' };
  }

  async #load(origin) {
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
      return { status: 'unavailable', reason: err.message };
    }
  }

  clear() {
    this.cache.clear();
  }
}
