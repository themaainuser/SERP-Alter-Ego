import path from "node:path";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

const bool = (v: string | undefined, d: boolean): boolean =>
  v == null || v === "" ? d : /^(1|true|yes|on)$/i.test(String(v));
const int = (v: string | undefined, d: number): number => {
  if (v == null || v === "") return d;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const list = (v: string | undefined): string[] => (v ? String(v).split(/\s+/).filter(Boolean) : []);

/**
 * Build the immutable startup configuration from environment variables.
 * Values under `settings` are only the *initial* values of options that can be changed
 * at runtime (see settings.js); everything else needs a restart.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const nodeEnv = env.NODE_ENV || "development";
  return Object.freeze({
    env: nodeEnv,
    host: env.HOST || "127.0.0.1",
    port: int(env.PORT, 3000),
    logLevel: env.LOG_LEVEL || (nodeEnv === "test" ? "silent" : "info"),
    logFormat: env.LOG_FORMAT || (nodeEnv === "production" ? "json" : "pretty"),
    dataDir: path.resolve(env.DATA_DIR || "./data"),
    persistSettings: bool(env.PERSIST_SETTINGS, nodeEnv !== "test"),
    publicBaseUrl: env.PUBLIC_BASE_URL || null,
    userAgent: env.USER_AGENT || DEFAULT_UA,
    robotsUserAgent: env.ROBOTS_USER_AGENT || "SerpAlterEgo",
    /**
     * Google's web/news results point at encrypted `google.com/goto?url=...` redirects that
     * only Google can decode. When enabled, the web engine follows each one (a single tiny
     * 302 lookup per result) so `link` carries the real destination URL. Set
     * `GOOGLE_RESOLVE_LINKS=false` to skip the follow-ups and leave `/goto` links as-is.
     */
    resolveGoogleLinks: bool(env.GOOGLE_RESOLVE_LINKS, true),
    /**
     * Headless web searches click the AI Overview's "Show more" control before the DOM is
     * captured, so `ai_overview` carries the expanded answer (SerpApi shape). Costs a bounded
     * wait per search (up to ~5s for the block to appear + ~8s for it to settle); when the page
     * has no AI Overview only the appearance wait is paid. Set `GOOGLE_EXPAND_AI=false` to skip.
     */
    googleExpandAi: bool(env.GOOGLE_EXPAND_AI, true),
    /**
     * Route outbound traffic through an HTTP(S) or SOCKS5 proxy — the primary defence against
     * Google's IP-reputation blocks, because a fresh residential IP is challenged far less
     * often than a datacenter one (this is what commercial SERP APIs actually run on). Applied
     * to Chromium via `--proxy-server` and to every Node fetch via undici's global dispatcher.
     * Accepts a full URL (`http://user:pass@host:port`, `socks5://host:port`) or a bare
     * `host:port` (treated as `http://`). Leave unset to go direct.
     */
    proxyUrl: env.PROXY_URL || null,
    defaults: Object.freeze({
      hl: env.DEFAULT_HL || "en",
      gl: env.DEFAULT_GL || "us",
      googleDomain: env.DEFAULT_GOOGLE_DOMAIN || "google.com",
      num: 10,
    }),
    settings: Object.freeze({
      headless: bool(env.HEADLESS, false),
      fallbackToHeadless: bool(env.HEADLESS_FALLBACK, false),
      robotsPolicy: env.ROBOTS_POLICY || "enforce",
      minIntervalMs: int(env.RATE_MIN_INTERVAL_MS, 2500),
      cacheTtlSeconds: int(env.CACHE_TTL_SECONDS, 300),
    }),
    http: Object.freeze({
      timeoutMs: int(env.HTTP_TIMEOUT_MS, 15000),
      maxRetries: int(env.HTTP_MAX_RETRIES, 2),
      retryBaseMs: int(env.HTTP_RETRY_BASE_MS, 800),
      maxBodyBytes: int(env.HTTP_MAX_BODY_BYTES, 10 * 1024 * 1024),
    }),
    browser: Object.freeze({
      executablePath: env.CHROME_PATH || env.PUPPETEER_EXECUTABLE_PATH || undefined,
      userDataDir: env.CHROME_USER_DATA_DIR || undefined,
      profileName: env.CHROME_PROFILE_NAME || env.CHROME_PROFILE || undefined,
      extraArgs: list(env.CHROME_ARGS),
      noSandbox: bool(env.CHROME_NO_SANDBOX, false),
      headful: bool(env.BROWSER_HEADFUL, false),
      /**
       * Navigate like a person instead of deep-linking: open the Google homepage, type the
       * query into the search box, submit, then land on the exact /search URL. A cold
       * `goto(/search?q=…)` from a fresh context is a strong bot signal; opening the homepage
       * and searching first gives the real navigation valid cookies + a referrer. Applies to
       * www.google.<tld>/search URLs only (other engines/domains navigate directly). Set
       * `BROWSER_HUMAN_SEARCH=false` to restore direct deep-linking.
       */
      humanSearch: bool(env.BROWSER_HUMAN_SEARCH, true),
      /**
       * Open-source anti-detection (the idea behind `nodriver`, ported to Puppeteer): drop the
       * `navigator.webdriver` tell and fill the `window.chrome.runtime` / permission-query gaps
       * that mark a page as automated, so Google issues far fewer challenges. Set
       * `BROWSER_STEALTH=false` to disable. (This is the "fingerprint" area the original README
       * declined; the project now opts into *gap-filling* anti-detection — see README.)
       */
      stealth: bool(env.BROWSER_STEALTH, true),
      /**
       * Optional third-party CAPTCHA solver for unattended runs — OFF by default, because the
       * human-in-loop below stays the default and needs no account or spend. Set
       * `CAPTCHA_SOLVER=2captcha` *and* `CAPTCHA_SOLVER_API_KEY=...` to auto-solve a Google
       * /sorry/ reCAPTCHA. Nothing is contacted unless both are present, and an unknown
       * provider name falls back to `none`. (Paid service you opt into — see README.)
       */
      captchaSolver: env.CAPTCHA_SOLVER?.toLowerCase() === "2captcha" ? "2captcha" : "none",
      captchaSolverKey: env.CAPTCHA_SOLVER_API_KEY || null,
      /** How long the solver gets to return a token and for the page to leave /sorry/. */
      captchaSolverTimeoutMs: int(env.CAPTCHA_SOLVER_TIMEOUT_MS, 60_000),
      /**
        * How many times the script tries to clear a /sorry/ CAPTCHA *itself* (re-navigation, plus
        * the solver above when one is configured) before it gives up and tells the operator to
        * solve it manually in the open window. The automatic phase runs first; the human prompt is
        * the escalation after these attempts fail. Set `CAPTCHA_MAX_AUTO_ATTEMPTS=0` to skip
        * straight to the manual prompt.
        */
      captchaMaxAutoAttempts: Math.max(0, int(env.CAPTCHA_MAX_AUTO_ATTEMPTS, 3)),
      /** Headful only: hold a CAPTCHA page open so a human can solve it, then continue. */
      captchaInteractive: bool(env.BROWSER_CAPTCHA_INTERACTIVE, true),
      /** How long to wait for the human solve before giving up. */
      captchaWaitMs: int(env.BROWSER_CAPTCHA_WAIT_MS, 3 * 60 * 1000),
      maxPages: Math.max(1, int(env.BROWSER_MAX_PAGES, 2)),
      navTimeoutMs: int(env.BROWSER_NAV_TIMEOUT_MS, 30000),
      readyTimeoutMs: int(env.BROWSER_READY_TIMEOUT_MS, 8000),
      idleCloseMs: int(env.BROWSER_IDLE_CLOSE_MS, 5 * 60 * 1000),
    }),
    limiter: Object.freeze({
      jitterMs: int(env.RATE_JITTER_MS, 500),
      concurrency: Math.max(1, int(env.RATE_CONCURRENCY, 1)),
      maxQueue: int(env.RATE_MAX_QUEUE, 25),
      maxWaitMs: int(env.RATE_MAX_WAIT_MS, 120000),
      cooldownMs: int(env.BLOCK_COOLDOWN_MS, 5 * 60 * 1000),
    }),
    archiveSize: int(env.ARCHIVE_SIZE, 25),
    /**
     * Optional directory to persist every successful search (`<id>.html` + `<id>.json`), so the
     * `/searches/<id>...` links (`raw_html_file`, `json_endpoint`) survive restarts the way
     * SerpApi's stored results do. Unset = in-memory ring buffer only (ARCHIVE_SIZE entries).
     */
    archiveDir: env.ARCHIVE_DIR ? path.resolve(env.ARCHIVE_DIR) : null,
    historySize: int(env.HISTORY_SIZE, 100),
    // Test/dev hooks: point the scraper at a different origin than google.com / news.google.com.
    upstream: Object.freeze({
      googleBase: env.UPSTREAM_GOOGLE_URL || null,
      newsBase: env.UPSTREAM_NEWS_URL || null,
    }),
  });
}

export type Config = ReturnType<typeof loadConfig>;
