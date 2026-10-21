import type { Browser, BrowserContext, CookieData, LaunchOptions, Page } from "puppeteer";
import type { Config } from "../config.js";
import { ScraperError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { PageRequest, RawPage } from "../types.js";
import { solveSorryCaptcha, solverEnabled } from "./captchaSolver.js";
import { CONSENT_COOKIE } from "./consent.js";
import { looksLikeCaptcha } from "./guards.js";
import { classifyNetworkError } from "./httpFetcher.js";
import { browserProxyArgs, browserProxyAuth } from "./proxy.js";
import { applyStealth, stealthLaunchArgs } from "./stealth.js";

const BLOCKED_RESOURCES = new Set(["image", "media", "font"]);

/** Matches www.google.<tld>/search URLs — the human-like search box flow applies to exactly these. */
function isGoogleSearchUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return /^(www\.)?google\.[a-z.]+$/.test(u.hostname) && u.pathname === "/search" && u.searchParams.has("q");
  } catch {
    return false;
  }
}

export type BrowserLauncher = (options: LaunchOptions) => Promise<Browser>;

const defaultLauncher: BrowserLauncher = async (options) => {
  const { default: puppeteer } = await import("puppeteer");
  return puppeteer.launch(options);
};

export interface RenderOptions {
  readySelector?: PageRequest["readySelector"];
  readyTimeoutMs?: PageRequest["readyTimeoutMs"];
  expandAiOverview?: PageRequest["expandAiOverview"];
  afterLoad?: PageRequest["afterLoad"];
  userAgent?: string;
  acceptLanguage?: string;
  cookies?: CookieData[];
}

/**
 * In-page script: click the AI Overview's "Show more" control and wait for the answer to
 * settle, so the captured DOM holds the expanded content. Passed as a STRING expression
 * because the server compiles without the DOM lib. Waits up to ~5s for the control to
 * appear (Google streams the block in after the results), clicks it, then waits until the
 * page text stops growing (or ~8s, whichever first). Returns true when a control was clicked.
 */
const EXPAND_AI_OVERVIEW = `(async () => {
  const find = () => document.querySelector('[aria-label="Show more AI Overview"]');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  let btn = find();
  while (!btn && Date.now() - t0 < 5000) { await sleep(200); btn = find(); }
  if (!btn) return false;
  const before = document.body.innerText.length;
  btn.click();
  const t1 = Date.now();
  let last = before;
  let stableSince = Date.now();
  while (Date.now() - t1 < 8000) {
    await sleep(150);
    if (!find()) return true; // the control vanished — expanded
    const n = document.body.innerText.length;
    if (n !== last) { last = n; stableSince = Date.now(); }
    else if (Date.now() - stableSince > (n > before ? 700 : 2500)) return true; // settled (or nothing to expand)
  }
  return true;
})()`;

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
 * Owns a single lazily-launched Chromium used when headless mode is ON. Ephemeral mode gives each
 * render an isolated browser context (no shared cookies); persistent mode (CHROME_USER_DATA_DIR)
 * shares the profile's default context so cookies/history persist. A bounded number of pages run
 * at once, and the browser is closed after an idle period or when headless mode is switched off.
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

  constructor({
    config,
    logger,
    launcher = defaultLauncher,
  }: {
    config: Config;
    logger?: Logger;
    launcher?: BrowserLauncher;
  }) {
    this.config = config;
    this.logger = logger;
    this.launcher = launcher;
  }

  async #ensureBrowser(): Promise<Browser> {
    if (this.browser?.connected) return this.browser;
    if (this.launching) return this.launching;
    const { browser: cfg } = this.config;
    // CHROME_PROFILE_NAME is a leaf like "Default" — never an absolute path.
    // A full User Data dir (contains Default/, Local State) belongs in CHROME_USER_DATA_DIR.
    let userDataDir = cfg.userDataDir;
    let profileName = cfg.profileName;
    if (!userDataDir && profileName && /[/\\:]/.test(profileName)) {
      this.logger?.warn(
        "CHROME_PROFILE_NAME looks like a path; using it as the User Data dir. Set CHROME_USER_DATA_DIR instead.",
        { profileName },
      );
      userDataDir = profileName;
      profileName = undefined;
    }
    const args = [
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--lang=en-US",
      ...(profileName ? [`--profile-directory=${profileName}`] : []),
      ...(cfg.noSandbox ? ["--no-sandbox", "--disable-setuid-sandbox"] : []),
      // Anti-detection (navigator.webdriver) + proxy, both no-ops when disabled/unset.
      ...stealthLaunchArgs(cfg.stealth),
      ...browserProxyArgs(this.config),
      ...cfg.extraArgs,
    ];
    this.launching = this.launcher({
      headless: !cfg.headful,
      executablePath: cfg.executablePath,
      ...(userDataDir ? { userDataDir } : {}),
      args,
      defaultViewport: { width: 1366, height: 900 },
    })
      .then((browser) => {
        this.browser = browser;
        this.launches++;
        this.logger?.info("Headless browser launched", { pid: safe(() => browser.process()?.pid) });
        browser.on("disconnected", () => {
          if (this.browser === browser) this.browser = null;
          this.logger?.warn("Headless browser disconnected");
        });
        return browser;
      })
      .catch((err: unknown) => {
        const profileHint = this.config.browser.userDataDir
          ? " If the profile is already open in Chrome, close it first (or copy the profile dir) — Chrome locks a User Data dir."
          : "";
        throw new ScraperError(
          "BROWSER_UNAVAILABLE",
          `Could not start the headless browser: ${firstLine(errorMessage(err))}. ` +
            'Install Chrome with "npm run install-browser", or set CHROME_PATH to an existing Chrome/Chromium binary ' +
            `(inside Docker/root also set CHROME_NO_SANDBOX=true). Or turn headless mode OFF.${profileHint}`,
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
        this.logger?.info("Closing idle headless browser");
        void this.close();
      }
    }, this.config.browser.idleCloseMs);
    this.idleTimer.unref?.();
  }

  /**
   * Load `url` and return the rendered DOM.
   * Ephemeral mode (no CHROME_USER_DATA_DIR): each render gets an isolated context (no shared cookies).
   * Persistent mode (CHROME_USER_DATA_DIR set): pages share the profile's default context, so
   * cookies/history/logins persist. Max-pages concurrency is still enforced.
   * `readySelector` (optional) is awaited best-effort; `expandAiOverview` clicks the AI
   * Overview's "Show more" control and waits for the answer to settle (best-effort);
   * `afterLoad(page)` may return extra data (e.g. intercepted XHR payloads) that is passed
   * back as `extras`.
   */
  async render(
    url: string,
    {
      readySelector,
      readyTimeoutMs,
      expandAiOverview,
      afterLoad,
      userAgent,
      acceptLanguage = "en-US,en;q=0.9",
      cookies = [],
    }: RenderOptions = {},
  ): Promise<RawPage> {
    const { browser: cfg } = this.config;
    clearTimeout(this.idleTimer);
    this.closeWhenDrained = false;
    await this.#acquire();
    let context: BrowserContext | undefined;
    let page: Page | undefined;
    let ownedContext = false;
    const t: Timings = { start: Date.now(), launched: 0, navigated: 0, ready: 0, after: 0 };
    try {
      const browser = await this.#ensureBrowser();
      t.launched = Date.now();
      if (cfg.userDataDir) {
        context = browser.defaultBrowserContext();
        page = await context.newPage();
      } else {
        context = await browser.createBrowserContext();
        ownedContext = true;
        page = await context.newPage();
      }
      await page.setUserAgent({ userAgent: userAgent || this.config.userAgent });
      await page.setExtraHTTPHeaders({ "accept-language": acceptLanguage });
      // Proxy credentials must be registered before any navigation, and the anti-detection
      // script must be injected before the first page load. Both are best-effort: neither may
      // ever abort a render.
      const proxyAuth = browserProxyAuth(this.config);
      if (proxyAuth) {
        try {
          await page.authenticate(proxyAuth);
        } catch (err) {
          this.logger?.warn("Proxy authentication could not be set up; proxy requests may be rejected (407).", {
            error: errorMessage(err),
          });
        }
      }
      await applyStealth(page, cfg.stealth);
      const host = new URL(url).hostname;
      const cookieDomain = /(^|\.)google\.[a-z.]+$/.test(host) ? `.${host.replace(/^www\./, "")}` : host;
      const allCookies: CookieData[] = [
        ...(/google\./.test(host)
          ? [{ name: "SOCS", value: CONSENT_COOKIE, domain: cookieDomain, path: "/" }]
          : []),
        ...cookies,
      ];
      if (allCookies.length) await page.setCookie(...allCookies);
      await page.setRequestInterception(true);
      const activePage: Page = page; // const alias: `let` narrowing is lost inside the closure below
      page.on("request", (req) => {
        // Keep the CAPTCHA challenge solvable: the image puzzle and reCAPTCHA assets are
        // exactly the "image" resources the filter drops, so let everything through while
        // the page is on Google's /sorry/ interstitial.
        const captchaPage = /\/sorry\//.test(activePage.url()) || /\/sorry\/|recaptcha/i.test(req.url());
        const action = !captchaPage && BLOCKED_RESOURCES.has(req.resourceType()) ? req.abort() : req.continue();
        action.catch(() => {});
      });

      // Human-like path: for Google search URLs, first open the homepage, type the query into
      // the search box and submit — then navigate to the exact target URL below. This mirrors
      // how a person searches (the final navigation gets a real referrer + cookies from the
      // homepage/search) instead of cold deep-linking to /search, the pattern bot checks flag.
      // Best-effort: if the search box can't be found, we simply fall through to the direct goto.
      if (cfg.humanSearch && isGoogleSearchUrl(url)) {
        await this.#humanWarmSearch(page, url, cfg);
      }

      let response;
      try {
        response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: cfg.navTimeoutMs });
      } catch (err) {
        if ((err as { name?: string } | null)?.name === "TimeoutError") {
          throw new ScraperError("UPSTREAM_TIMEOUT", `Page load timed out after ${cfg.navTimeoutMs}ms.`, {
            cause: err,
          });
        }
        throw classifyNetworkError(err, url, cfg.navTimeoutMs);
      }

      t.navigated = Date.now();
      let landed = page.url();
      let interstitial = /\/sorry\/|consent\./.test(landed);
      let solvedCaptcha = false;

      // Google redirected to /sorry/. The script FIRST tries to clear it itself — up to
      // `captchaMaxAutoAttempts` automatic attempts (a re-navigation, plus the configured solver
      // when one is enabled). Only when that automatic phase still fails does it escalate: it tells
      // the operator to solve it manually and holds the page open for them (the human-in-loop
      // default). So: script handles it → after the attempts fail → human is asked to take over.
      if (interstitial && /\/sorry\//.test(landed)) {
        const maxAuto = cfg.captchaMaxAutoAttempts;

        // --- Automatic phase: the script clears the challenge on its own, up to `maxAuto` times. ---
        for (let attempt = 1; attempt <= maxAuto; attempt += 1) {
          if (!/\/sorry\//.test(page.url())) {
            solvedCaptcha = true; // cleared somewhere along the way
            break;
          }
          this.logger?.info(`Automatic CAPTCHA clear — attempt ${attempt}/${maxAuto}`, { url: page.url() });
          if (await this.#attemptAutomaticClear(page, cfg, url)) {
            solvedCaptcha = true;
            this.logger?.info("CAPTCHA cleared automatically", { attempts: attempt, url: page.url() });
            break;
          }
        }
        if (!solvedCaptcha && !/\/sorry\//.test(page.url())) solvedCaptcha = true;

        // --- Escalation: the automatic attempts failed — tell the human to solve it manually. ---
        if (!solvedCaptcha) {
          if (cfg.headful && cfg.captchaInteractive) {
            this.logger?.warn(
              `CAPTCHA not cleared after ${maxAuto} automatic attempt(s) — please solve it manually in the open browser window; the scrape continues once you do.`,
              { waitMs: cfg.captchaWaitMs, url: page.url() },
            );
            if (await this.#waitForCaptchaSolve(page, cfg.captchaWaitMs)) {
              solvedCaptcha = true;
              this.logger?.info("CAPTCHA solved manually; continuing the scrape", { url: page.url() });
            } else {
              this.logger?.warn("Timed out waiting for the manual CAPTCHA solve.", {
                waitMs: cfg.captchaWaitMs,
                url: page.url(),
              });
            }
          } else if (!cfg.headful) {
            this.logger?.warn(
              `CAPTCHA not cleared after ${maxAuto} automatic attempt(s), and no browser window is visible (BROWSER_HEADFUL=false) — re-run with BROWSER_HEADFUL=true so you can solve it manually.`,
              { url: page.url() },
            );
          } else {
            this.logger?.warn(
              `CAPTCHA not cleared after ${maxAuto} automatic attempt(s), and interactive solving is off (BROWSER_CAPTCHA_INTERACTIVE=false).`,
              { url: page.url() },
            );
          }
        }

        // After ANY solve: re-read the final URL and let Google hydrate the empty SERP shell.
        if (solvedCaptcha) {
          landed = page.url();
          interstitial = /\/sorry\/|consent\./.test(landed);
          if (!interstitial) {
            // Post-solve Google serves an EMPTY SERP shell and hydrates the results over
            // XHR, so the ready selector can match before a single result exists. Let the
            // network go quiet first; the ready wait below still guards the final state.
            await page.waitForNetworkIdle({ idleTime: 800, timeout: 8000 }).catch(() => {});
          }
        }
      }

      const readyMs = readyTimeoutMs ?? cfg.readyTimeoutMs;
      if (readySelector && !interstitial) {
        try {
          await page.waitForSelector(readySelector, { timeout: readyMs });
        } catch {
          // Not fatal — parse whatever rendered — but make the miss visible instead of
          // swallowing it silently (the silent catch hid empty-result bugs).
          this.logger?.warn("Ready selector never appeared; parsing what rendered.", {
            readySelector,
            timeoutMs: readyMs,
            url: page.url(),
          });
        }
      }
      t.ready = Date.now();
      // Expand the AI Overview (if any) before anything reads the DOM: the block streams in
      // after the results, hence the generous in-page waits; a page without one only pays them.
      if (expandAiOverview && !interstitial) {
        try {
          const clicked = (await page.evaluate(EXPAND_AI_OVERVIEW)) as boolean;
          if (clicked) this.logger?.debug("AI Overview expanded", { url: page.url() });
        } catch (err) {
          this.logger?.warn("Could not expand the AI Overview; capturing the page as rendered.", { err: String(err) });
        }
      }
      const extras = afterLoad && !interstitial ? await afterLoad(page) : undefined;
      t.after = Date.now();
      const html = await page.content();
      this.logger?.debug("Rendered page", {
        host,
        browserMs: t.launched - t.start,
        navigateMs: t.navigated - t.launched,
        readyMs: t.ready - t.navigated,
        afterLoadMs: t.after - t.ready,
        contentMs: Date.now() - t.after,
      });
      // A solved CAPTCHA must report 200: `response` still holds the /sorry/ status (429),
      // which classifyPage treats as a block regardless of the now-good HTML.
      return { html, url: page.url(), status: solvedCaptcha ? 200 : (response?.status() ?? 200), extras };
    } finally {
      if (ownedContext && context) await context.close().catch(() => {});
      else await page?.close().catch(() => {});
      this.#release();
    }
  }

  /**
   * One automatic attempt to clear a /sorry/ challenge without human help: use the configured
   * solver when one is enabled (it fetches a token and submits the form), otherwise re-navigate to
   * the target — a fresh GET sometimes clears a transient risk-score block that replaying the
   * exact same request would keep hitting. Returns true when the page is off /sorry/ afterward.
   */
  async #attemptAutomaticClear(page: Page, cfg: Config["browser"], targetUrl: string): Promise<boolean> {
    if (solverEnabled(cfg) && (await solveSorryCaptcha(page, cfg, this.logger))) return true;
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: cfg.navTimeoutMs }).catch(() => {});
    return !/\/sorry\//.test(page.url());
  }

  /**
   * Hold the page open until the operator solves a Google CAPTCHA by hand.
   * Resolves true once the browser leaves /sorry/ (Google redirects back to the original
   * URL) or the page no longer looks like a CAPTCHA, false if `waitMs` elapses first.
   * Polls `page.url()` rather than `waitForFunction` so a cross-document redirect during
   * the solve can't destroy the execution context and abort the wait.
   */
  async #waitForCaptchaSolve(page: Page, waitMs: number): Promise<boolean> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        const current = page.url();
        if (!/\/sorry\//.test(current)) return true;
        if (!looksLikeCaptcha(await page.content(), current)) return true;
      } catch {
        // The page may be mid-navigation; treat as "still a CAPTCHA" and retry.
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false; // one final check already happened at the deadline
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, remaining)));
    }
  }

  /**
   * Open the Google homepage and type the query into the search box the way a person would, so
   * the caller's subsequent navigation to the full search URL leaves from a warm session: the
   * homepage has set cookies, and the search request carries a real `Referer` instead of
   * arriving as a cold deep-link to /search (the pattern bot checks flag).
   *
   * The caller's `goto(targetUrl)` is the single, correctly-parameterized search submission —
   * we deliberately do NOT press Enter here. Submitting the bare box too would fire a second
   * /search request moments after the first (a rapid re-search that itself looks automated)
   * and only ever produce a page with the wrong num/hl/tbm/start that we'd discard anyway.
   *
   * Best-effort: returns false (and the caller falls back to direct navigation) if the homepage
   * or its search box cannot be reached.
   */
  async #humanWarmSearch(page: Page, url: string, cfg: Config["browser"]): Promise<boolean> {
    const query = new URL(url).searchParams.get("q");
    if (!query) return false;
    const home = `${new URL(url).origin}/`;
    const box = 'textarea[name="q"], input[name="q"]';
    const warmTimeout = Math.min(cfg.navTimeoutMs, 15000);
    try {
      await page.goto(home, { waitUntil: "domcontentloaded", timeout: warmTimeout });
      await page.waitForSelector(box, { timeout: Math.min(5000, warmTimeout) });
      // Human-ish keystroke pacing; the box may be a <textarea> (modern homepage) or <input>.
      // This also paces the two navigations ~0.5s apart, like a person pausing to type.
      await page.type(box, query, { delay: 20 });
      this.logger?.debug("Human-like search warm-up engaged", { home, query });
      return true;
    } catch (err) {
      this.logger?.debug("Human-like search warm-up skipped; using direct navigation.", {
        error: errorMessage(err),
        url,
      });
      return false;
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
      this.logger?.info("Closing headless browser");
      await browser.close().catch(() => {});
    }
  }

  status(): BrowserStatus {
    return { running: Boolean(this.browser?.connected), activePages: this.active, launches: this.launches };
  }
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const firstLine = (s = ""): string => String(s).split("\n")[0] ?? "";
function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
