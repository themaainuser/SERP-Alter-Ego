import { badRequest } from '../errors.js';
import { parseGoogleWeb } from '../parsers/googleWeb.js';
import { parseSearchNews } from '../parsers/googleNews.js';
import { parseShopping } from '../parsers/googleShopping.js';
import { parseImages } from '../parsers/googleImages.js';
import { encodeUule, googleOrigin, readCommon, reader } from '../serpapi/params.js';

const TBM = { nws: 'news', shop: 'shopping', isch: 'images' };

const READY = {
  web: '#search, #rso, #main',
  news: '#search, #rso, #main',
  shopping: '[data-docid], .sh-dgr__grid-result, #search, #main',
  images: 'a[href*="/imgres"], [data-lpage], #search, #main',
};

/** Build the normalized parameter set shared by the Google web/shopping/images engines. */
function normalizeGoogle(raw, defaults, { kind, engine }) {
  const r = reader(raw);
  const q = r.str('q', { max: 1000 });
  if (!q) throw badRequest('Missing query `q` parameter.');
  const common = readCommon(r, defaults);
  const location = r.str('location', { max: 200 });
  const p = {
    engine,
    kind,
    q,
    ...common,
    num: r.int('num', { min: 1, max: 100 }),
    start: r.int('start', { min: 0, max: 10000 }),
    ijn: r.int('ijn', { min: 0, max: 100 }),
    safe: r.enum('safe', ['active', 'off']),
    tbs: r.str('tbs', { max: 200 }),
    lr: r.str('lr', { max: 40 }),
    cr: r.str('cr', { max: 80 }),
    nfpr: r.enum('nfpr', ['0', '1']),
    filter: r.enum('filter', ['0', '1']),
    location,
    uule: r.str('uule', { max: 300 }) ?? (location ? encodeUule(location) : undefined),
  };
  return p;
}

/** Keys echoed back in `search_parameters` (in SerpApi's order). */
function echo(p, extra = []) {
  const keys = ['engine', 'q', 'location', 'google_domain', 'hl', 'gl', 'safe', 'num', 'start', 'ijn', 'tbs', 'lr', 'cr', 'nfpr', 'filter', ...extra, 'device'];
  const out = {};
  for (const k of keys) if (p[k] !== undefined && p[k] !== null) out[k] = p[k];
  if (p.location) out.location_requested = p.location;
  return out;
}

function searchUrl(p, config) {
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
  for (const k of ['safe', 'tbs', 'lr', 'cr', 'nfpr', 'filter', 'uule']) if (p[k]) s.set(k, p[k]);
  return u.href;
}

function paginate(p, { count, config, link, googleUrl }) {
  if (!count) return {};
  if (p.kind === 'images') {
    const current = p.ijn ?? 0;
    return {
      serpapi_pagination: { current, next: link({ ijn: current + 1 }) },
    };
  }
  const size = p.num ?? config.defaults.num;
  const start = p.start ?? 0;
  const current = Math.floor(start / size) + 1;
  const other = (fn) => Object.fromEntries(Array.from({ length: 9 }, (_, i) => i + 2).filter((n) => n !== current).map((n) => [n, fn((n - 1) * size)]));
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

function makeEngine(engine, kind, echoExtra = []) {
  return {
    id: engine,
    normalize: (raw, defaults) => normalizeGoogle(raw, defaults, { kind, engine }),
    echo: (p) => echo(p, echoExtra),
    plan(p, { config }) {
      const url = searchUrl(p, config);
      const baseUrl = new URL(url).origin;
      return {
        googleUrl: url,
        request: {
          url,
          readySelector: READY[kind],
          acceptLanguage: `${p.hl},en;q=0.8`,
        },
        parse(page, { link }) {
          const start = p.start ?? 0;
          let parsed;
          let data;
          let count;
          if (kind === 'web') {
            parsed = parseGoogleWeb(page.html, { baseUrl, start, query: p.q, buildSerpApiLink: (q) => link({ q, start: undefined, tbm: undefined }) });
            data = parsed.data;
            count = data.organic_results?.length ?? 0;
          } else if (kind === 'news') {
            parsed = parseSearchNews(page.html, { baseUrl, start });
            data = { news_results: parsed.news_results };
            count = parsed.news_results.length;
          } else if (kind === 'shopping') {
            parsed = parseShopping(page.html, { baseUrl });
            data = { shopping_results: p.num ? parsed.shopping_results.slice(0, p.num) : parsed.shopping_results };
            count = data.shopping_results.length;
          } else {
            parsed = parseImages(page.html, { baseUrl, start: (p.ijn ?? 0) * 100, query: p.q });
            data = {
              search_information: { query_displayed: p.q, image_results_state: parsed.images_results.length ? 'Results for exact spelling' : 'Fully empty' },
              images_results: p.num ? parsed.images_results.slice(0, p.num) : parsed.images_results,
              suggested_searches: parsed.suggested_searches.map(({ q, ...s }) => ({ ...s, q, serpapi_link: link({ q, ijn: undefined }) })),
            };
            count = data.images_results.length;
          }
          const pagination = paginate(p, {
            count,
            config,
            link: (o) => link(o),
            googleUrl: (o) => searchUrl({ ...p, ...o }, config),
          });
          return {
            data: { ...data, ...pagination },
            empty: count === 0,
            emptyMessage: "Google hasn't returned any results for this query.",
          };
        },
      };
    },
  };
}

const webEngine = makeEngine('google', 'web');
const newsTab = makeEngine('google', 'news', ['tbm']);
const shoppingTab = makeEngine('google', 'shopping', ['tbm']);
const imagesTab = makeEngine('google', 'images', ['tbm']);
const TAB_ENGINES = { news: newsTab, shopping: shoppingTab, images: imagesTab };

/** `engine=google` — the `tbm` parameter switches to the news / shopping / images tab. */
export const google = {
  id: 'google',
  resolve(raw) {
    const tbm = reader(raw).enum('tbm', Object.keys(TBM));
    if (!tbm) return webEngine;
    const tab = TAB_ENGINES[TBM[tbm]];
    return { ...tab, normalize: (r, defaults) => ({ ...tab.normalize(r, defaults), tbm }) };
  },
};

export const googleShopping = makeEngine('google_shopping', 'shopping');
export const googleImages = makeEngine('google_images', 'images');

export { TBM };
