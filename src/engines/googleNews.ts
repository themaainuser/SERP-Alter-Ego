import { badRequest, ScraperError } from '../errors.js';
import { parseNewsPage, parseNewsRss } from '../parsers/googleNews.js';
import { readCommon, reader } from '../serpapi/params.js';
import { type BaseParams, defineEngine, type Json } from '../types.js';

const TOKEN = /^[A-Za-z0-9_-]{8,300}$/;

export interface NewsParams extends BaseParams {
  num?: number;
  topic_token?: string;
  publication_token?: string;
  story_token?: string;
  section_token?: string;
}

function locale(hl: string, gl: string): { hl: string; gl: string; ceid: string } {
  const [lang, region] = hl.split('-');
  const country = (region && region.length === 2 ? region : gl).toUpperCase();
  return { hl: `${lang}-${country}`, gl: country, ceid: `${country}:${lang}` };
}

function feedPath(p: NewsParams, feed: boolean): { path: string; rssOk: boolean } {
  const prefix = feed ? '/rss' : '';
  if (p.story_token) return { path: `${prefix}/stories/${p.story_token}`, rssOk: false };
  if (p.publication_token) return { path: `${prefix}/publications/${p.publication_token}`, rssOk: true };
  if (p.topic_token && p.section_token) return { path: `${prefix}/topics/${p.topic_token}/sections/${p.section_token}`, rssOk: false };
  if (p.topic_token) return { path: `${prefix}/topics/${p.topic_token}`, rssOk: true };
  return { path: `${prefix}/search`, rssOk: true };
}

/** `engine=google_news`: RSS feed in HTTP mode, rendered news.google.com in headless mode. */
export const googleNews = defineEngine<NewsParams>({
  id: 'google_news',
  normalize(raw, defaults) {
    const r = reader(raw);
    const common = readCommon(r, defaults);
    const p: NewsParams = {
      engine: 'google_news',
      q: r.str('q', { max: 1000 }),
      ...common,
      num: r.int('num', { min: 1, max: 100 }),
      topic_token: r.str('topic_token', { pattern: TOKEN }),
      publication_token: r.str('publication_token', { pattern: TOKEN }),
      story_token: r.str('story_token', { pattern: TOKEN }),
      section_token: r.str('section_token', { pattern: TOKEN }),
    };
    if (!p.q && !p.topic_token && !p.publication_token && !p.story_token) {
      throw badRequest('Missing query `q` parameter (or one of `topic_token`, `publication_token`, `story_token`).');
    }
    return p;
  },
  echo(p) {
    const fields: Record<string, unknown> = { ...p };
    const out: Json = {};
    for (const k of ['engine', 'q', 'gl', 'hl', 'topic_token', 'publication_token', 'story_token', 'section_token', 'num', 'device']) {
      if (fields[k] !== undefined) out[k] = fields[k];
    }
    return out;
  },
  plan(p, { config, mode }) {
    const loc = locale(p.hl, p.gl);
    const feed = mode === 'http';
    const { path: pathname, rssOk } = feedPath(p, feed);
    if (feed && !rssOk) {
      throw new ScraperError('JS_REQUIRED', '`story_token` / `section_token` searches need a browser: turn headless mode ON (or enable the headless fallback).');
    }
    const base = (config.upstream.newsBase || 'https://news.google.com').replace(/\/$/, '');
    const u = new URL(base + pathname);
    if (pathname.endsWith('/search')) u.searchParams.set('q', p.q ?? '');
    u.searchParams.set('hl', loc.hl);
    u.searchParams.set('gl', loc.gl);
    u.searchParams.set('ceid', loc.ceid);
    return {
      googleUrl: new URL(u.href.replace('/rss/', '/')).href,
      request: { url: u.href, readySelector: 'article', acceptLanguage: `${loc.hl},en;q=0.8` },
      parse(page) {
        const parsed = feed ? parseNewsRss(page.html) : parseNewsPage(page.html);
        const results = p.num ? parsed.news_results.slice(0, p.num) : parsed.news_results;
        return {
          data: { news_results: results },
          empty: results.length === 0,
          emptyMessage: "Google News hasn't returned any results for this query.",
        };
      },
    };
  },
});
