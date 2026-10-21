import type { Page } from 'puppeteer';
import type { Config } from './config.js';

export type Mode = 'http' | 'headless';
export type Json = Record<string, unknown>;
/** Raw (unvalidated) query-string values as parsed by Express. */
export type Query = Record<string, unknown>;
/** How robots.txt was applied to a fetch; reported as `search_metadata.robots_txt`. */
export type RobotsOutcome = 'allowed' | 'disallowed' | 'skipped' | 'unknown';

/** Extra data an engine can capture from a live browser page (e.g. XHR payloads). */
export interface PageExtras {
  payloads?: unknown[];
  windowOnly?: boolean;
}

export interface PageRequest {
  url: string;
  mode: Mode;
  /** Headless only: awaited best-effort before the DOM is read. */
  readySelector?: string;
  /** Headless only: overrides `BROWSER_READY_TIMEOUT_MS` for this request. */
  readyTimeoutMs?: number;
  /**
   * Headless only: after the page is ready, clicks Google's "Show more" control on the AI
   * Overview (waiting for the block to appear and then to settle) so the captured DOM holds
   * the expanded answer rather than the clamped preview. Best-effort: a page without an AI
   * Overview simply times out the wait and captures as-is.
   */
  expandAiOverview?: boolean;
  /** Headless only: runs after load; its result is returned as `extras`. */
  afterLoad?: (page: Page) => Promise<PageExtras>;
  headers?: Record<string, string>;
  acceptLanguage?: string;
  /** HTTP statuses >= 400 that should still be treated as a usable page. */
  okStatuses?: number[];
}

export interface RawPage {
  html: string;
  url: string;
  status: number;
  extras?: PageExtras;
}

export interface FetchedPage extends RawPage {
  mode: Mode;
  robots: RobotsOutcome;
}

/** Builds a `/search.json` link for the same search with some parameters overridden. */
export type LinkBuilder = (overrides?: Record<string, unknown>) => string;

export interface ParseOutcome {
  /** Engine-specific response keys (spread into the SerpApi envelope). */
  data: object;
  empty: boolean;
  emptyMessage?: string;
}

export interface EnginePlan {
  /** Human-facing page the data came from (reported as `search_metadata.google_url`). */
  googleUrl: string;
  request: Omit<PageRequest, 'mode'>;
  /**
   * May be async so an engine can do follow-up work on its own (e.g. Google's web engine
   * resolves the encrypted `/goto` result links back to real destination URLs).
   */
  parse(page: FetchedPage, ctx: { link: LinkBuilder }): ParseOutcome | Promise<ParseOutcome>;
}

/** Parameters every engine understands. */
export interface BaseParams {
  engine: string;
  q?: string;
  hl: string;
  gl: string;
  google_domain: string;
  /** Only desktop is supported; other values are rejected during validation. */
  device: 'desktop';
  no_cache: boolean;
  output: 'json' | 'html';
  headless?: boolean;
}

export type Defaults = Config['defaults'];

export interface Engine<P extends BaseParams = BaseParams> {
  id: string;
  normalize(raw: Query, defaults: Defaults): P;
  /** The parameters reported back as `search_parameters`. */
  echo(params: P): Json;
  plan(params: P, ctx: { config: Config; mode: Mode }): EnginePlan;
}

/**
 * Engines are written against their own parameter type; the registry and service only see the
 * erased `Engine`. This is the one place that erasure is asserted.
 */
export function defineEngine<P extends BaseParams>(engine: Engine<P>): Engine {
  return engine as unknown as Engine;
}
