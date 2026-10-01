import { randomBytes } from 'node:crypto';
import { ScraperError, toScraperError } from '../errors.js';
import { resolveEngine } from '../engines/index.js';

/**
 * Orchestrates one SerpApi-style search: validate -> pick mode (HTTP / headless) -> cache ->
 * scrape -> parse -> wrap in SerpApi's response envelope -> archive.
 */
export class SearchService {
  constructor({ config, settings, scraper, cache, logger }) {
    this.config = config;
    this.settings = settings;
    this.scraper = scraper;
    this.cache = cache;
    this.logger = logger;
    this.archive = new Map();
    this.recent = [];
  }

  history() {
    return [...this.recent].reverse();
  }

  getArchived(id) {
    return this.archive.get(id);
  }

  #record(entry) {
    this.recent.push(entry);
    while (this.recent.length > this.config.historySize) this.recent.shift();
  }

  #archive(id, value) {
    this.archive.set(id, value);
    while (this.archive.size > this.config.archiveSize) this.archive.delete(this.archive.keys().next().value);
  }

  async search(rawQuery, { baseUrl }) {
    const started = Date.now();
    const entry = {
      at: new Date(started).toISOString(),
      engine: String(rawQuery.engine ?? 'google'),
      q: typeof rawQuery.q === 'string' ? rawQuery.q : undefined,
    };
    try {
      const result = await this.#run(rawQuery, { baseUrl, started });
      this.#record({ ...entry, id: result.id, ok: true, status: 200, mode: result.mode, cached: result.cached, empty: Boolean(result.body.error), ms: Date.now() - started });
      return result;
    } catch (err) {
      const e = toScraperError(err);
      if (e.code === 'INTERNAL_ERROR') this.logger.error('Unexpected error while searching', { error: err.cause ?? err });
      this.#record({ ...entry, ok: false, status: e.status, code: e.code, error: e.message, ms: Date.now() - started });
      throw e;
    }
  }

  async #run(rawQuery, { baseUrl, started }) {
    const engine = resolveEngine(rawQuery);
    const params = engine.normalize(rawQuery, this.config.defaults);
    const settings = this.settings.snapshot();
    const mode = (params.headless ?? settings.headless) ? 'headless' : 'http';
    const echo = engine.echo(params);

    const link = (overrides = {}) => {
      const merged = { ...echo, ...overrides };
      delete merged.location_requested;
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(merged)) if (v !== undefined && v !== null) qs.set(k, String(v));
      return `${baseUrl}/search.json?${qs}`;
    };

    const cacheKey = JSON.stringify([engine.id, mode, echo]);
    const ttlMs = settings.cacheTtlSeconds * 1000;
    if (!params.no_cache && ttlMs > 0) {
      const hit = this.cache.get(cacheKey);
      if (hit) {
        this.logger.debug('Cache hit', { engine: engine.id, q: params.q });
        return { ...hit, cached: true };
      }
    }

    const attempt = async (m) => {
      const plan = engine.plan(params, { config: this.config, mode: m });
      const page = await this.scraper.fetchPage({ ...plan.request, mode: m });
      return { plan, page, parsed: plan.parse(page, { link }) };
    };

    let outcome;
    let usedMode = mode;
    let fellBack = false;
    try {
      outcome = await attempt(mode);
    } catch (err) {
      if (!(err instanceof ScraperError && err.code === 'JS_REQUIRED' && mode === 'http' && settings.fallbackToHeadless)) throw err;
      this.logger.info('HTTP mode cannot serve this search; falling back to headless', { engine: engine.id, reason: err.message });
      usedMode = 'headless';
      fellBack = true;
      outcome = await attempt('headless');
    }

    const { plan, page, parsed } = outcome;
    const id = randomBytes(12).toString('hex');
    const processedAt = new Date();
    const metadata = {
      id,
      status: 'Success',
      json_endpoint: `${baseUrl}/searches/${id}.json`,
      created_at: formatTimestamp(new Date(started)),
      processed_at: formatTimestamp(processedAt),
      google_url: plan.googleUrl,
      raw_html_file: `${baseUrl}/searches/${id}.html`,
      total_time_taken: Number(((processedAt.getTime() - started) / 1000).toFixed(2)),
      scraper_mode: usedMode,
      ...(fellBack ? { scraper_fallback: true } : {}),
      robots_txt: page.robots,
    };
    const body = { search_metadata: metadata, search_parameters: echo, ...parsed.data };
    if (parsed.empty) body.error = parsed.emptyMessage;

    const result = { id, body, html: page.html, mode: usedMode, cached: false };
    this.#archive(id, { body, html: page.html });
    if (ttlMs > 0 && !parsed.empty) this.cache.set(cacheKey, result, ttlMs);
    return result;
  }
}

const pad = (n) => String(n).padStart(2, '0');
function formatTimestamp(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}
