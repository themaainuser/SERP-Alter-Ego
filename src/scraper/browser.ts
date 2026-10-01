import type { Browser, BrowserContext, CookieData, LaunchOptions, Page } from 'puppeteer';
import type { Config } from '../config.js';
import { ScraperError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { PageRequest, RawPage } from '../types.js';
import { CONSENT_COOKIE } from './consent.js';
import { classifyNetworkError } from './httpFetcher.js';

const BLOCKED_RESOURCES = new Set(['image', 'media', 'font']);

export type BrowserLauncher = (options: LaunchOptions) => Promise<Browser>;

const defaultLauncher: BrowserLauncher = async (options) => {
  const { default: puppeteer } = await import('puppeteer');
  return puppeteer.launch(options);
};

export interface RenderOptions {
  readySelector?: PageRequest['readySelector'];
  afterLoad?: PageRequest['afterLoad'];
  userAgent?: string;
  acceptLanguage?: string;
  cookies?: CookieData[];
}

export interface BrowserStatus {
  running: boolean;
  activePages: number;
  launches: number;
}

interface Timings {
  start: number;
  launched: number;
  navigated: number;
  ready: number;
  after: number;
}

/**
 * Owns a single lazily-launched Chromium used when headless mode is ON. Each render gets an
 * isolated browser context (no shared cookies), a bounded number of pages run at once, and the
 * browser is closed after an idle period or when headless mode is switched off.
 */
export class BrowserManager {
  private readonly config: Config;
  private readonly logger: Logger | undefined;
  private readonly launcher: BrowserLauncher;
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private idleTimer: NodeJS.Timeout | undefined;
  private closeWhenDrained = false;
  private launches = 0;

  constructor({ config, logger, launcher = defaultLauncher }: { config: Config; logger?: Logger; launcher?: BrowserLauncher }) {
    this.config = config;
    this.logger = logger;
    this.launcher = launcher;
  }

  async #ensureBrowser(): Promise<Browser> {
    if (this.browser?.connected) return this.browser;
    if (this.launching) return this.launching;
    const { browser: cfg } = this.config;
    const args = [
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--lang=en-US',
      ...(cfg.noSandbox ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
      ...cfg.extraArgs,
    ];
    this.launching = this.launcher({
      headless: !cfg.headful,
      executablePath: cfg.executablePath,
      args,
      defaultViewport: { width: 1366, height: 900 },
    })
      .then((browser) => {
        this.browser = browser;
        this.launches++;
        this.logger?.info('Headless browser launched', { pid: safe(() => browser.process()?.pid) });
        browser.on('disconnected', () => {
          if (this.browser === browser) this.browser = null;
          this.logger?.warn('Headless browser disconnected');
        });
        return browser;
      })
      .catch((err: unknown) => {
        throw new ScraperError(
          'BROWSER_UNAVAILABLE',
          `Could not start the headless browser: ${firstLine(errorMessage(err))}. ` +
            'Install Chrome with "npm run install-browser", or set CHROME_PATH to an existing Chrome/Chromium binary ' +
            '(inside Docker/root also set CHROME_NO_SANDBOX=true). Or turn headless mode OFF.',
          { cause: err },
        );
      })
      .finally(() => {
        this.launching = null;
      });
    return this.launching;
  }

  async #acquire(): Promise<void> {
    if (this.active < this.config.browser.maxPages) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  #release(): void {
    const next = this.waiters.shift();
    if (next) return next(); // hand the slot straight to the next waiter
    this.active--;
    if (this.active === 0) {
      if (this.closeWhenDrained) void this.close();
      else this.#armIdleTimer();
    }
  }

  #armIdleTimer(): void {
    clearTimeout(this.idleTimer);
    if (!this.browser || this.config.browser.idleCloseMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.active === 0) {
        this.logger?.info('Closing idle headless browser');
        void this.close();
      }
    }, this.config.browser.idleCloseMs);
    this.idleTimer.unref?.();
  }

  /**
   * Load `url` in a fresh context and return the rendered DOM.
   * `readySelector` (optional) is awaited best-effort; `afterLoad(page)` may return extra data
   * (e.g. intercepted XHR payloads) that is passed back as `extras`.
   */
  async render(
    url: string,
    { readySelector, afterLoad, userAgent, acceptLanguage = 'en-US,en;q=0.9', cookies = [] }: RenderOptions = {},
  ): Promise<RawPage> {
    const { browser: cfg } = this.config;
    clearTimeout(this.idleTimer);
    this.closeWhenDrained = false;
    await this.#acquire();
    let context: BrowserContext | undefined;
    const t: Timings = { start: Date.now(), launched: 0, navigated: 0, ready: 0, after: 0 };
    try {
      const browser = await this.#ensureBrowser();
      t.launched = Date.now();
      context = await browser.createBrowserContext();
      const page: Page = await context.newPage();
      await page.setUserAgent({ userAgent: userAgent || this.config.userAgent });
      await page.setExtraHTTPHeaders({ 'accept-language': acceptLanguage });
      const host = new URL(url).hostname;
      const cookieDomain = /(^|\.)google\.[a-z.]+$/.test(host) ? `.${host.replace(/^www\./, '')}` : host;
      const allCookies: CookieData[] = [
        ...(/google\./.test(host) ? [{ name: 'SOCS', value: CONSENT_COOKIE, domain: cookieDomain, path: '/' }] : []),
        ...cookies,
      ];
      if (allCookies.length) await page.setCookie(...allCookies);
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const action = BLOCKED_RESOURCES.has(req.resourceType()) ? req.abort() : req.continue();
        action.catch(() => {});
      });

      let response;
      try {
        response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs });
      } catch (err) {
        if ((err as { name?: string } | null)?.name === 'TimeoutError') {
          throw new ScraperError('UPSTREAM_TIMEOUT', `Page load timed out after ${cfg.navTimeoutMs}ms.`, { cause: err });
        }
        throw classifyNetworkError(err, url, cfg.navTimeoutMs);
      }

      t.navigated = Date.now();
      const landed = page.url();
      const interstitial = /\/sorry\/|consent\./.test(landed);
      if (readySelector && !interstitial) {
        await page.waitForSelector(readySelector, { timeout: cfg.readyTimeoutMs }).catch(() => {});
      }
      t.ready = Date.now();
      const extras = afterLoad && !interstitial ? await afterLoad(page) : undefined;
      t.after = Date.now();
      const html = await page.content();
      this.logger?.debug('Rendered page', {
        host,
        browserMs: t.launched - t.start,
        navigateMs: t.navigated - t.launched,
        readyMs: t.ready - t.navigated,
        afterLoadMs: t.after - t.ready,
        contentMs: Date.now() - t.after,
      });
      return { html, url: page.url(), status: response?.status() ?? 200, extras };
    } finally {
      if (context) await context.close().catch(() => {});
      this.#release();
    }
  }

  /** Close the browser now, or as soon as in-flight pages finish. */
  async close(): Promise<void> {
    clearTimeout(this.idleTimer);
    if (this.active > 0) {
      this.closeWhenDrained = true;
      return;
    }
    const browser = this.browser;
    this.browser = null;
    if (browser) {
      this.logger?.info('Closing headless browser');
      await browser.close().catch(() => {});
    }
  }

  status(): BrowserStatus {
    return { running: Boolean(this.browser?.connected), activePages: this.active, launches: this.launches };
  }
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const firstLine = (s = ''): string => String(s).split('\n')[0] ?? '';
function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
