import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { loadConfig } from './config.js';
import { ENGINE_IDS } from './engines/index.js';
import { ScraperError, toScraperError } from './errors.js';
import { createLogger, redactUrl } from './logger.js';
import { SearchService } from './service/searchService.js';
import { BrowserManager } from './scraper/browser.js';
import { TtlCache } from './scraper/cache.js';
import { HttpFetcher } from './scraper/httpFetcher.js';
import { RateLimiter } from './scraper/rateLimiter.js';
import { RobotsChecker } from './scraper/robots.js';
import { Scraper } from './scraper/scraper.js';
import { SettingsStore } from './settings.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const startedAt = Date.now();

/**
 * Wire everything together. Dependencies that touch the network or a browser can be replaced
 * through `overrides` (used by the tests).
 */
export function createApp({ config = loadConfig(), logger, overrides = {} } = {}) {
  logger ??= createLogger({ level: config.logLevel, format: config.logFormat });

  const settings = new SettingsStore({
    defaults: config.settings,
    filePath: config.persistSettings ? path.join(config.dataDir, 'settings.json') : null,
    logger,
  });
  const http = new HttpFetcher({ config, fetchImpl: overrides.fetchImpl });
  const browser = new BrowserManager({ config, logger, launcher: overrides.launcher });
  const limiter = new RateLimiter({ ...config.limiter, getMinIntervalMs: () => settings.get('minIntervalMs'), logger });
  const robots = new RobotsChecker({
    fetchText: (url) => http.get(url, { timeoutMs: 8000 }),
    userAgent: config.robotsUserAgent,
    logger,
  });
  const scraper = new Scraper({ config, settings, http, browser, robots, limiter, logger, sleepFn: overrides.sleepFn });
  const cache = new TtlCache();
  const service = new SearchService({ config, settings, scraper, cache, logger });

  // Switching headless OFF releases the browser (after in-flight pages finish). Cached results are
  // dropped when the mode or robots policy changes so the new setting takes effect immediately.
  settings.onChange((now, before) => {
    if (before.headless && !now.headless) void browser.close();
    if (before.headless !== now.headless || before.robotsPolicy !== now.robotsPolicy) cache.clear();
    logger.info('Settings changed', { settings: now });
  });

  const app = express();
  app.disable('x-powered-by');
  app.set('json spaces', 2);

  app.use((req, res, next) => {
    req.id = req.get('x-request-id') || randomUUID();
    res.set('X-Request-Id', req.id);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Content-Security-Policy', "default-src 'self'; img-src * data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const started = Date.now();
    res.on('finish', () => {
      const quiet = req.path.startsWith('/api/status') || req.path === '/health' || !/^\/(search|searches|api)/.test(req.path);
      logger[quiet ? 'debug' : 'info']('request', { id: req.id, method: req.method, url: redactUrl(req.originalUrl), status: res.statusCode, ms: Date.now() - started });
    });
    next();
  });

  // The API has no authentication, so when it listens on loopback only, refuse requests whose Host header
  // is not loopback. This blocks DNS-rebinding attacks from web pages open in the user's browser.
  if (LOOPBACK.has(config.host)) {
    app.use((req, res, next) => {
      const hostname = (req.get('host') || '').replace(/:\d+$/, '').toLowerCase();
      if (LOOPBACK.has(hostname)) return next();
      return res.status(403).json({ error: 'Forbidden host header.', error_code: 'FORBIDDEN_HOST' });
    });
  }

  const baseUrlOf = (req) => config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;

  async function handleSearch(req, res, forcedOutput) {
    const raw = { ...req.query };
    const result = await service.search(raw, { baseUrl: baseUrlOf(req) });
    res.set('X-Scraper-Mode', result.mode);
    res.set('X-Cache', result.cached ? 'HIT' : 'MISS');
    const wantsHtml = forcedOutput === 'html' || String(raw.output).toLowerCase() === 'html';
    if (wantsHtml) {
      const isXml = result.html.trimStart().startsWith('<?xml');
      return res.type(isXml ? 'application/xml' : 'text/html').send(result.html);
    }
    return res.json(result.body);
  }

  const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
  app.get(['/search', '/search.json'], wrap((req, res) => handleSearch(req, res)));
  app.get('/search.html', wrap((req, res) => handleSearch(req, res, 'html')));

  app.get('/searches/:file', (req, res, next) => {
    const m = /^([a-f0-9]{24})\.(json|html)$/.exec(req.params.file);
    const found = m && service.getArchived(m[1]);
    if (!found) return next(new ScraperError('NOT_FOUND', 'Search not found. Only the most recent searches are kept in memory.'));
    if (m[2] === 'html') return res.type(found.html.trimStart().startsWith('<?xml') ? 'application/xml' : 'text/html').send(found.html);
    return res.json(found.body);
  });

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  // ---- Admin API used by the web UI (and handy for scripts) ----
  const status = () => ({
    status: 'ok',
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    mode: settings.get('headless') ? 'headless' : 'http',
    settings: settings.snapshot(),
    engines: ENGINE_IDS,
    browser: browser.status(),
    limiter: limiter.status(),
    cache: cache.stats(),
  });
  app.get('/api/status', (req, res) => res.json(status()));
  app.get('/api/history', (req, res) => res.json({ history: service.history() }));
  app.get('/api/settings', (req, res) => res.json(settings.snapshot()));
  app.patch('/api/settings', express.json({ limit: '4kb', type: 'application/json' }), (req, res) => {
    res.json(settings.update(req.body));
  });
  app.delete('/api/settings', (req, res) => res.json(settings.reset()));

  app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: 0 }));

  app.use((req, res, next) => next(new ScraperError('NOT_FOUND', `No route for ${req.method} ${req.path}.`)));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    let e;
    if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
      e = new ScraperError('INVALID_PARAMETER', 'Request body must be valid JSON.');
    } else {
      e = toScraperError(err);
    }
    if (e.status >= 500) logger.error('Request failed', { id: req.id, url: redactUrl(req.originalUrl), error: e.cause ?? e });
    else logger.warn('Request rejected', { id: req.id, url: redactUrl(req.originalUrl), code: e.code, message: e.message });
    if (e.retryAfter) res.set('Retry-After', String(e.retryAfter));
    res.status(e.status).json({ error: e.message, error_code: e.code });
  });

  async function close() {
    await browser.close();
  }

  return { app, close, components: { config, settings, service, scraper, browser, limiter, robots, cache, http } };
}
