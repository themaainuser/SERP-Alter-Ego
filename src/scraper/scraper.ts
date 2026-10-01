import type { Config } from '../config.js';
import { ScraperError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { SettingsStore } from '../settings.js';
import type { FetchedPage, PageRequest, RawPage, RobotsOutcome } from '../types.js';
import type { BrowserManager } from './browser.js';
import { CONSENT_COOKIE } from './consent.js';
import { classifyPage } from './guards.js';
import type { HttpFetcher } from './httpFetcher.js';
import { type RateLimiter, sleep } from './rateLimiter.js';
import type { RobotsChecker } from './robots.js';

const RETRYABLE = new Set(['UPSTREAM_NETWORK_ERROR', 'UPSTREAM_TIMEOUT', 'UPSTREAM_HTTP_ERROR']);
const isRetryable = (err: unknown): boolean => err instanceof ScraperError && RETRYABLE.has(err.code) && err.details?.retryable !== false;

/**
 * Fetches one page for an engine: robots.txt policy -> per-host rate limit -> HTTP or
 * headless fetch -> block/CAPTCHA/JS-wall detection, with retries for transient failures.
 */
export interface ScraperDeps {
  config: Config;
  settings: SettingsStore;
  http: HttpFetcher;
  browser: BrowserManager;
  robots: RobotsChecker;
  limiter: RateLimiter;
  logger?: Logger;
  sleepFn?: (ms: number) => Promise<void>;
}

export class Scraper {
  private readonly config: Config;
  private readonly settings: SettingsStore;
  private readonly http: HttpFetcher;
  private readonly browser: BrowserManager;
  private readonly robots: RobotsChecker;
  private readonly limiter: RateLimiter;
  private readonly logger: Logger | undefined;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor({ config, settings, http, browser, robots, limiter, logger, sleepFn = sleep }: ScraperDeps) {
    this.config = config;
    this.settings = settings;
    this.http = http;
    this.browser = browser;
    this.robots = robots;
    this.limiter = limiter;
    this.logger = logger;
    this.sleep = sleepFn;
  }

  async fetchPage(request: PageRequest): Promise<FetchedPage> {
    const { url, mode } = request;
    const robotsStatus = await this.#applyRobotsPolicy(url);
    const host = new URL(url).host;
    const maxRetries = this.config.http.maxRetries;

    for (let attempt = 0; ; attempt++) {
      try {
        const page = await this.limiter.run(host, () => this.#fetchOnce(request, host));
        return { ...page, mode, robots: robotsStatus };
      } catch (err) {
        if (!isRetryable(err) || attempt >= maxRetries) throw err;
        const delay = this.config.http.retryBaseMs * 2 ** attempt + Math.random() * 250;
        this.logger?.warn('Transient upstream failure; retrying', { host, attempt: attempt + 1, delay: Math.round(delay), error: err });
        await this.sleep(delay);
      }
    }
  }

  async #applyRobotsPolicy(url: string): Promise<RobotsOutcome> {
    const policy = this.settings.get('robotsPolicy');
    if (policy === 'off') return 'skipped';
    const check = await this.robots.check(url);
    if (check.status === 'allowed') return 'allowed';
    const host = new URL(url).host;
    if (check.status === 'disallowed') {
      if (policy === 'enforce') {
        throw new ScraperError(
          'ROBOTS_DISALLOWED',
          `${host}/robots.txt disallows fetching this URL, and the robots policy is "enforce". ` +
            'Change the policy to "warn" or "off" (Settings in the web UI, PATCH /api/settings, or ROBOTS_POLICY) only if you accept responsibility for scraping it.',
          { details: { url } },
        );
      }
      this.logger?.warn('robots.txt disallows this URL; continuing because policy is "warn"', { url });
      return 'disallowed';
    }
    const reason = check.reason;
    if (policy === 'enforce') {
      throw new ScraperError('ROBOTS_UNAVAILABLE', `Could not read ${host}/robots.txt (${reason}); refusing to scrape while the policy is "enforce".`);
    }
    this.logger?.warn('robots.txt unavailable; continuing because policy is not "enforce"', { host, reason });
    return 'unknown';
  }

  async #fetchOnce({ url, mode, readySelector, afterLoad, headers, acceptLanguage, okStatuses = [] }: PageRequest, host: string): Promise<RawPage> {
    const started = Date.now();
    const raw =
      mode === 'headless'
        ? await this.browser.render(url, { readySelector, afterLoad, acceptLanguage })
        : await this.#httpGet(url, headers, acceptLanguage);

    const problem = classifyPage(raw, { mode, host });
    if (problem) {
      if (problem.code === 'UPSTREAM_BLOCKED') this.limiter.block(host, this.config.limiter.cooldownMs, problem.details?.captcha ? 'captcha' : 'http-429');
      throw problem;
    }
    if (raw.status >= 400 && !okStatuses.includes(raw.status)) {
      // Only server-side errors are worth retrying; a 4xx will not change on a second attempt.
      throw new ScraperError('UPSTREAM_HTTP_ERROR', `${host} answered HTTP ${raw.status}.`, {
        details: { status: raw.status, retryable: raw.status >= 500 },
      });
    }
    this.logger?.debug('Fetched page', { host, mode, status: raw.status, bytes: raw.html.length, ms: Date.now() - started });
    return raw;
  }

  async #httpGet(url: string, headers: Record<string, string> = {}, acceptLanguage?: string): Promise<RawPage> {
    const res = await this.http.get(url, {
      headers: {
        ...(acceptLanguage ? { 'accept-language': acceptLanguage } : {}),
        ...(/google\./.test(new URL(url).hostname) ? { cookie: `SOCS=${CONSENT_COOKIE}` } : {}),
        ...headers,
      },
    });
    return { html: res.body, url: res.url, status: res.status };
  }
}
