import { randomBytes } from 'node:crypto';
import type { Config } from '../config.js';
import { resolveEngine } from '../engines/index.js';
import { type ErrorCode, ScraperError, toScraperError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { TtlCache } from '../scraper/cache.js';
import type { Scraper } from '../scraper/scraper.js';
import type { SettingsStore } from '../settings.js';
import type { Json, Mode, Query, RobotsOutcome } from '../types.js';

export interface SearchMetadata {
  id: string;
  status: 'Success';
  json_endpoint: string;
  created_at: string;
  processed_at: string;
  google_url: string;
  raw_html_file: string;
  total_time_taken: number;
  scraper_mode: Mode;
  scraper_fallback?: true;
  robots_txt: RobotsOutcome;
}

/** SerpApi-style response: envelope plus the engine's result keys. */
export interface SearchBody {
  search_metadata: SearchMetadata;
  search_parameters: Json;
  /** Present when the page was valid but had no results. */
  error?: string;
  [resultKey: string]: unknown;
}

export interface SearchResult {
  id: string;
  body: SearchBody;
  html: string;
  mode: Mode;
  cached: boolean;
}

export interface HistoryEntry {
  at: string;
  engine: string;
  q?: string;
  id?: string;
  ok: boolean;
  status: number;
  mode?: Mode;
  cached?: boolean;
  empty?: boolean;
  code?: ErrorCode;
  error?: string;
  ms: number;
}

export interface SearchServiceDeps {
  config: Config;
  settings: SettingsStore;
  scraper: Scraper;
  cache: TtlCache<SearchResult>;
  logger: Logger;
}

/**
 * Orchestrates one SerpApi-style search: validate -> pick mode (HTTP / headless) -> cache ->
 * scrape -> parse -> wrap in SerpApi's response envelope -> archive.
 */
export class SearchService {
  private readonly config: Config;
  private readonly settings: SettingsStore;
  private readonly scraper: Scraper;
  private readonly cache: TtlCache<SearchResult>;
  private readonly logger: Logger;
  private readonly archive = new Map<string, { body: SearchBody; html: string }>();
  private readonly recent: HistoryEntry[] = [];

  constructor({ config, settings, scraper, cache, logger }: SearchServiceDeps) {
    this.config = config;
    this.settings = settings;
    this.scraper = scraper;
    this.cache = cache;
    this.logger = logger;
  }

  history(): HistoryEntry[] {
    return [...this.recent].reverse();
  }

  getArchived(id: string): { body: SearchBody; html: string } | undefined {
    return this.archive.get(id);
  }

  #record(entry: HistoryEntry): void {
    this.recent.push(entry);
    while (this.recent.length > this.config.historySize) this.recent.shift();
  }

  #archive(id: string, value: { body: SearchBody; html: string }): void {
    this.archive.set(id, value);
    for (const oldest of this.archive.keys()) {
      if (this.archive.size <= this.config.archiveSize) break;
      this.archive.delete(oldest);
    }
  }

  async search(rawQuery: Query, { baseUrl }: { baseUrl: string }): Promise<SearchResult> {
    const started = Date.now();
    const base = {
      at: new Date(started).toISOString(),
      engine: String(rawQuery.engine ?? 'google'),
      q: typeof rawQuery.q === 'string' ? rawQuery.q : undefined,
    };
    try {
      const result = await this.#run(rawQuery, { baseUrl, started });
      this.#record({ ...base, id: result.id, ok: true, status: 200, mode: result.mode, cached: result.cached, empty: Boolean(result.body.error), ms: Date.now() - started });
      return result;
    } catch (err) {
      const e = toScraperError(err);
      if (e.code === 'INTERNAL_ERROR') this.logger.error('Unexpected error while searching', { error: e.cause ?? err });
      this.#record({ ...base, ok: false, status: e.status, code: e.code, error: e.message, ms: Date.now() - started });
      throw e;
    }
  }

  async #run(rawQuery: Query, { baseUrl, started }: { baseUrl: string; started: number }): Promise<SearchResult> {
    const engine = resolveEngine(rawQuery);
    const params = engine.normalize(rawQuery, this.config.defaults);
    const settings = this.settings.snapshot();
    const mode: Mode = (params.headless ?? settings.headless) ? 'headless' : 'http';
    const echo = engine.echo(params);

    const link = (overrides: Record<string, unknown> = {}): string => {
      const merged: Record<string, unknown> = { ...echo, ...overrides };
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

    const attempt = async (m: Mode) => {
      const plan = engine.plan(params, { config: this.config, mode: m });
      const page = await this.scraper.fetchPage({ ...plan.request, mode: m });
      return { plan, page, parsed: plan.parse(page, { link }) };
    };

    let outcome: Awaited<ReturnType<typeof attempt>>;
    let usedMode: Mode = mode;
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
    const metadata: SearchMetadata = {
      id,
      status: 'Success',
      json_endpoint: `${baseUrl}/searches/${id}.json`,
      created_at: formatTimestamp(new Date(started)),
      processed_at: formatTimestamp(processedAt),
      google_url: plan.googleUrl,
      raw_html_file: `${baseUrl}/searches/${id}.html`,
      total_time_taken: Number(((processedAt.getTime() - started) / 1000).toFixed(2)),
      scraper_mode: usedMode,
      ...(fellBack ? { scraper_fallback: true as const } : {}),
      robots_txt: page.robots,
    };
    const body: SearchBody = { search_metadata: metadata, search_parameters: echo, ...parsed.data };
    if (parsed.empty) body.error = parsed.emptyMessage;

    const result: SearchResult = { id, body, html: page.html, mode: usedMode, cached: false };
    this.#archive(id, { body, html: page.html });
    if (ttlMs > 0 && !parsed.empty) this.cache.set(cacheKey, result, ttlMs);
    return result;
  }
}

const pad = (n: number): string => String(n).padStart(2, '0');
function formatTimestamp(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}
