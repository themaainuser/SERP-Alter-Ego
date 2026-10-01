import { ScraperError } from '../errors.js';
import { CONSENT_COOKIE } from './consent.js';
import { classifyNetworkError } from './httpFetcher.js';

const BLOCKED_RESOURCES = new Set(['image', 'media', 'font']);

const defaultLauncher = async (options) => {
  const { default: puppeteer } = await import('puppeteer');
  return puppeteer.launch(options);
};

/**
 * Owns a single lazily-launched Chromium used when headless mode is ON. Each render gets an
 * isolated browser context (no shared cookies), a bounded number of pages run at once, and the
 * browser is closed after an idle period or when headless mode is switched off.
 */
export class BrowserManager {
  constructor({ config, logger, launcher = defaultLauncher }) {
    this.config = config;
    this.logger = logger;
    this.launcher = launcher;
    this.browser = null;
    this.launching = null;
    this.active = 0;
    this.waiters = [];
    this.idleTimer = null;
    this.closeWhenDrained = false;
    this.launches = 0;
  }

  async #ensureBrowser() {
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
        this.logger?.info('Headless browser launched', { version: safe(() => browser.process?.()?.pid) });
        browser.on('disconnected', () => {
          if (this.browser === browser) this.browser = null;
          this.logger?.warn('Headless browser disconnected');
        });
        return browser;
      })
      .catch((err) => {
        throw new ScraperError(
          'BROWSER_UNAVAILABLE',
          `Could not start the headless browser: ${firstLine(err.message)}. ` +
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

  async #acquire() {
    if (this.active < this.config.browser.maxPages) {
      this.active++;
      return;
    }
    await new Promise((resolve) => this.waiters.push(resolve));
  }

  #release() {
    const next = this.waiters.shift();
    if (next) return next(); // hand the slot straight to the next waiter
    this.active--;
    if (this.active === 0) {
      if (this.closeWhenDrained) void this.close();
      else this.#armIdleTimer();
    }
  }

  #armIdleTimer() {
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
  async render(url, { readySelector, afterLoad, userAgent, acceptLanguage = 'en-US,en;q=0.9', cookies = [] } = {}) {
    const { browser: cfg } = this.config;
    clearTimeout(this.idleTimer);
    this.closeWhenDrained = false;
    await this.#acquire();
    let context;
    const t = { start: Date.now() };
    try {
      const browser = await this.#ensureBrowser();
      t.launched = Date.now();
      context = await browser.createBrowserContext();
      const page = await context.newPage();
      await page.setUserAgent({ userAgent: userAgent || this.config.userAgent });
      await page.setExtraHTTPHeaders({ 'accept-language': acceptLanguage });
      const host = new URL(url).hostname;
      const cookieDomain = /(^|\.)google\.[a-z.]+$/.test(host) ? `.${host.replace(/^www\./, '')}` : host;
      const allCookies = [
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
        if (err?.name === 'TimeoutError') {
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
  async close() {
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

  status() {
    return { running: Boolean(this.browser?.connected), activePages: this.active, launches: this.launches };
  }
}

const firstLine = (s = '') => String(s).split('\n')[0];
const safe = (fn) => {
  try {
    return fn();
  } catch {
    return undefined;
  }
};
