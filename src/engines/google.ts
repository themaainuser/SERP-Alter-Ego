import type { Config } from '../config.js';
import { badRequest } from '../errors.js';
import { parseGoogleWeb } from '../parsers/googleWeb.js';
import { parseSearchNews } from '../parsers/googleNews.js';
import { parseShopping } from '../parsers/googleShopping.js';
import { parseImages } from '../parsers/googleImages.js';
import { encodeUule, googleOrigin, readCommon, reader } from '../serpapi/params.js';
import { type BaseParams, type Defaults, defineEngine, type Engine, type Json, type LinkBuilder, type ParseOutcome, type Query } from '../types.js';

type Kind = 'web' | 'news' | 'shopping' | 'images';

/** `tbm` values of the Google web endpoint, mapped to the tab they select. */
export const TBM = { nws: 'news', shop: 'shopping', isch: 'images' } as const;
type Tbm = keyof typeof TBM;

export interface GoogleParams extends BaseParams {
  kind: Kind;
  q: string;
  num?: number;
  start?: number;
  ijn?: number;
  safe?: 'active' | 'off';
  tbs?: string;
  lr?: string;
  cr?: string;
  nfpr?: '0' | '1';
  filter?: '0' | '1';
  location?: string;
  uule?: string;
  tbm?: Tbm;
}

const READY: Record<Kind, string> = {
  web: '#search, #rso, #main',
  news: '#search, #rso, #main',
  shopping: '[data-docid], .sh-dgr__grid-result, #search, #main',
  images: 'a[href*="/imgres"], [data-lpage], #search, #main',
};

const EMPTY_MESSAGE = "Google hasn't returned any results for this query.";

/** Build the normalized parameter set shared by the Google web/shopping/images engines. */
function normalizeGoogle(raw: Query, defaults: Defaults, { kind, engine }: { kind: Kind; engine: string }): GoogleParams {
  const r = reader(raw);
  const q = r.str('q', { max: 1000 });
  if (!q) throw badRequest('Missing query `q` parameter.');
  const common = readCommon(r, defaults);
  const location = r.str('location', { max: 200 });
  return {
    engine,
    kind,
    q,
    ...common,
    num: r.int('num', { min: 1, max: 100 }),
    start: r.int('start', { min: 0, max: 10000 }),
    ijn: r.int('ijn', { min: 0, max: 100 }),
    safe: r.enum('safe', ['active', 'off'] as const),
    tbs: r.str('tbs', { max: 200 }),
    lr: r.str('lr', { max: 40 }),
    cr: r.str('cr', { max: 80 }),
    nfpr: r.enum('nfpr', ['0', '1'] as const),
    filter: r.enum('filter', ['0', '1'] as const),
    location,
    uule: r.str('uule', { max: 300 }) ?? (location ? encodeUule(location) : undefined),
  };
}

/** Keys echoed back in `search_parameters` (in SerpApi's order). */
function echo(p: GoogleParams, extra: string[] = []): Json {
  const keys = ['engine', 'q', 'location', 'google_domain', 'hl', 'gl', 'safe', 'num', 'start', 'ijn', 'tbs', 'lr', 'cr', 'nfpr', 'filter', ...extra, 'device'];
  const fields: Record<string, unknown> = { ...p };
  const out: Json = {};
  for (const k of keys) if (fields[k] !== undefined && fields[k] !== null) out[k] = fields[k];
  if (p.location) out.location_requested = p.location;
  return out;
}

function searchUrl(p: GoogleParams, config: Config): string {
  const u = new URL('/search', googleOrigin(p.google_domain, config));
  const s = u.searchParams;
  s.set('q', p.q);
  s.set('hl', p.hl);
  s.set('gl', p.gl);
  if (p.kind === 'web' && (p.num ?? config.defaults.num) !== 10) s.set('num', String(p.num));
  else if (p.kind === 'news' && p.num) s.set('num', String(p.num));
  if (p.start) s.set('start', String(p.start));
  if (p.kind === 'news') s.set('tbm', 'nws');
  if (p.kind === 'shopping') s.set('udm', '28');
  if (p.kind === 'images') {
    s.set('tbm', 'isch');
    if (p.ijn) s.set('ijn', String(p.ijn));
  }
  s.set('pws', '0');
  for (const k of ['safe', 'tbs', 'lr', 'cr', 'nfpr', 'filter', 'uule'] as const) {
    const v = p[k];
    if (v) s.set(k, v);
  }
  return u.href;
}

interface PaginateContext {
  count: number;
  config: Config;
  link: LinkBuilder;
  googleUrl: (overrides: { start: number }) => string;
}

function paginate(p: GoogleParams, { count, config, link, googleUrl }: PaginateContext): Json {
  if (!count) return {};
  if (p.kind === 'images') {
    const current = p.ijn ?? 0;
    return { serpapi_pagination: { current, next: link({ ijn: current + 1 }) } };
  }
  const size = p.num ?? config.defaults.num;
  const start = p.start ?? 0;
  const current = Math.floor(start / size) + 1;
  const other = (fn: (start: number) => string): Record<number, string> =>
    Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => i + 2)
        .filter((n) => n !== current)
        .map((n) => [n, fn((n - 1) * size)]),
    );
  const nextStart = current * size;
  return {
    pagination: { current, next: googleUrl({ start: nextStart }), other_pages: other((s) => googleUrl({ start: s })) },
    serpapi_pagination: {
      current,
      next_link: link({ start: nextStart }),
      next: link({ start: nextStart }),
      other_pages: other((s) => link({ start: s })),
    },
  };
}

function makeEngine(engine: string, kind: Kind, echoExtra: string[] = []): Engine<GoogleParams> {
  return {
    id: engine,
    normalize: (raw, defaults) => normalizeGoogle(raw, defaults, { kind, engine }),
    echo: (p) => echo(p, echoExtra),
    plan(p, { config }) {
      const url = searchUrl(p, config);
      const baseUrl = new URL(url).origin;
      return {
        googleUrl: url,
        request: { url, readySelector: READY[kind], acceptLanguage: `${p.hl},en;q=0.8` },
        parse(page, { link }): ParseOutcome {
          const start = p.start ?? 0;
          let data: object;
          let count: number;
          if (kind === 'web') {
            const parsed = parseGoogleWeb(page.html, { baseUrl, start, query: p.q, buildSerpApiLink: (q) => link({ q, start: undefined, tbm: undefined }) });
            data = parsed.data;
            count = parsed.data.organic_results?.length ?? 0;
          } else if (kind === 'news') {
            const parsed = parseSearchNews(page.html, { baseUrl, start });
            data = { news_results: parsed.news_results };
            count = parsed.news_results.length;
          } else if (kind === 'shopping') {
            const parsed = parseShopping(page.html, { baseUrl });
            const results = p.num ? parsed.shopping_results.slice(0, p.num) : parsed.shopping_results;
            data = { shopping_results: results };
            count = results.length;
          } else {
            const parsed = parseImages(page.html, { baseUrl, start: (p.ijn ?? 0) * 100, query: p.q });
            const results = p.num ? parsed.images_results.slice(0, p.num) : parsed.images_results;
            data = {
              search_information: { query_displayed: p.q, image_results_state: results.length ? 'Results for exact spelling' : 'Fully empty' },
              images_results: results,
              suggested_searches: parsed.suggested_searches.map((s) => ({ ...s, serpapi_link: link({ q: s.q, ijn: undefined }) })),
            };
            count = results.length;
          }
          const pagination = paginate(p, { count, config, link, googleUrl: (o) => searchUrl({ ...p, ...o }, config) });
          return { data: { ...data, ...pagination }, empty: count === 0, emptyMessage: EMPTY_MESSAGE };
        },
      };
    },
  };
}

const webEngine = defineEngine(makeEngine('google', 'web'));
const TAB_ENGINES: Record<Kind, Engine<GoogleParams> | undefined> = {
  web: undefined,
  news: makeEngine('google', 'news', ['tbm']),
  shopping: makeEngine('google', 'shopping', ['tbm']),
  images: makeEngine('google', 'images', ['tbm']),
};

/** `engine=google`: the `tbm` parameter switches to the news / shopping / images tab. */
export const google = {
  id: 'google',
  resolve(raw: Query): Engine {
    const tbm = reader(raw).enum('tbm', Object.keys(TBM) as Tbm[]);
    if (!tbm) return webEngine;
    const tab = TAB_ENGINES[TBM[tbm]] as Engine<GoogleParams>;
    return defineEngine<GoogleParams>({ ...tab, normalize: (r, defaults) => ({ ...tab.normalize(r, defaults), tbm }) });
  },
};

export const googleShopping = defineEngine(makeEngine('google_shopping', 'shopping'));
export const googleImages = defineEngine(makeEngine('google_images', 'images'));
