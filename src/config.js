import path from 'node:path';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

const bool = (v, d) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));
const int = (v, d) => {
  if (v == null || v === '') return d;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const list = (v) => (v ? String(v).split(/\s+/).filter(Boolean) : []);

/**
 * Build the immutable startup configuration from environment variables.
 * Values under `settings` are only the *initial* values of options that can be changed
 * at runtime (see settings.js); everything else needs a restart.
 */
export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  return Object.freeze({
    env: nodeEnv,
    host: env.HOST || '127.0.0.1',
    port: int(env.PORT, 3000),
    logLevel: env.LOG_LEVEL || (nodeEnv === 'test' ? 'silent' : 'info'),
    logFormat: env.LOG_FORMAT || (nodeEnv === 'production' ? 'json' : 'pretty'),
    dataDir: path.resolve(env.DATA_DIR || './data'),
    persistSettings: bool(env.PERSIST_SETTINGS, nodeEnv !== 'test'),
    publicBaseUrl: env.PUBLIC_BASE_URL || null,
    userAgent: env.USER_AGENT || DEFAULT_UA,
    robotsUserAgent: env.ROBOTS_USER_AGENT || 'SerpAlterEgo',
    defaults: Object.freeze({
      hl: env.DEFAULT_HL || 'en',
      gl: env.DEFAULT_GL || 'us',
      googleDomain: env.DEFAULT_GOOGLE_DOMAIN || 'google.com',
      num: 10,
    }),
    settings: Object.freeze({
      headless: bool(env.HEADLESS, false),
      fallbackToHeadless: bool(env.HEADLESS_FALLBACK, false),
      robotsPolicy: env.ROBOTS_POLICY || 'enforce',
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
      extraArgs: list(env.CHROME_ARGS),
      noSandbox: bool(env.CHROME_NO_SANDBOX, false),
      headful: bool(env.BROWSER_HEADFUL, false),
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
    historySize: int(env.HISTORY_SIZE, 100),
    // Test/dev hooks: point the scraper at a different origin than google.com / news.google.com.
    upstream: Object.freeze({
      googleBase: env.UPSTREAM_GOOGLE_URL || null,
      newsBase: env.UPSTREAM_NEWS_URL || null,
    }),
  });
}
