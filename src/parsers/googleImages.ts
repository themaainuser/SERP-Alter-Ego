import * as cheerio from 'cheerio';
import { absoluteUrl, clean, compact, isGoogleHost, parseError, parseNumber } from './common.js';

/** `images_results` entry. */
export interface ImageResult {
  position: number;
  thumbnail?: string;
  related_content_id?: string;
  source?: string;
  title?: string;
  link?: string;
  original?: string;
  original_width?: number;
  original_height?: number;
  is_product?: boolean;
}
export interface SuggestedSearch {
  name: string;
  link?: string;
  q: string;
  thumbnail?: string;
}
export interface ImagesParse {
  images_results: ImageResult[];
  suggested_searches: SuggestedSearch[];
  hasLayout: boolean;
}

function hostLabel(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/**
 * Parse a rendered Google Images page. Tiles link to /imgres?imgurl=<original>&imgrefurl=<page>&w=&h=,
 * which carries everything SerpApi's `images_results` needs; `data-lpage` tiles are a fallback.
 */
export function parseImages(
  html: string,
  { baseUrl = 'https://www.google.com', start = 0, query = '' }: { baseUrl?: string; start?: number; query?: string } = {},
): ImagesParse {
  const $ = cheerio.load(html);
  const hasLayout = $('#search, #rso, #main, #islrg, [data-lpage], a[href*="/imgres"]').length > 0;
  const results: ImageResult[] = [];
  const seen = new Set<string>();

  const push = (entry: Omit<ImageResult, 'position'>): void => {
    const key = entry.original || entry.thumbnail || entry.link;
    if (!key || seen.has(key)) return;
    seen.add(key);
    results.push(compact({ position: start + results.length + 1, ...entry }));
  };

  $('a[href*="/imgres?"]').each((_, el) => {
    const a = $(el);
    const u = new URL(a.attr('href') ?? '', baseUrl);
    const original = absoluteUrl(u.searchParams.get('imgurl'), baseUrl);
    const page = absoluteUrl(u.searchParams.get('imgrefurl'), baseUrl);
    if (!original) return;
    const img = a.find('img').first();
    const thumb = img.attr('src') || img.attr('data-src');
    const tile = a.closest('[data-lpage], [data-id], div').first();
    const title =
      clean(a.attr('aria-label') || img.attr('alt') || tile.find('h3, [role="heading"], .toI8Rb').first().text()) || undefined;
    push({
      thumbnail: thumb && /^(data:|https?:)/.test(thumb) ? thumb : undefined,
      related_content_id: u.searchParams.get('tbnid') || undefined,
      source: clean(tile.find('.fxgdke, .guK3rf, .xuQ19b, .NUnG9d').first().text()) || hostLabel(page),
      title,
      link: page ?? undefined,
      original,
      original_width: parseNumber(u.searchParams.get('w')) ?? undefined,
      original_height: parseNumber(u.searchParams.get('h')) ?? undefined,
      is_product: /product|shop/i.test(a.text()) || undefined,
    });
  });

  if (!results.length) {
    $('[data-lpage]').each((_, el) => {
      const tile = $(el);
      const page = absoluteUrl(tile.attr('data-lpage'), baseUrl);
      if (!page || isGoogleHost(new URL(page).hostname)) return;
      const img = tile.find('img').first();
      const thumb = img.attr('src') || img.attr('data-src');
      push({
        thumbnail: thumb && /^(data:|https?:)/.test(thumb) ? thumb : undefined,
        source: hostLabel(page),
        title: clean(img.attr('alt') || tile.find('h3').first().text()) || undefined,
        link: page,
      });
    });
  }

  if (!results.length && !hasLayout) {
    throw parseError('Google Images page was not recognised (no image grid found); the layout may have changed or the page did not finish rendering.');
  }

  const suggested: SuggestedSearch[] = [];
  $('a[href*="udm=2"][href*="q="]').each((_, el) => {
    const a = $(el);
    const href = a.attr('href') ?? '';
    const name = clean(a.text());
    const q = new URL(href, baseUrl).searchParams.get('q');
    if (!name || !q || q === query || a.closest('#search, #rso').length || suggested.some((s) => s.q === q)) return;
    suggested.push(compact({ name, link: absoluteUrl(href, baseUrl) ?? undefined, q, thumbnail: a.find('img').first().attr('src') }));
  });

  return { images_results: results, suggested_searches: suggested, hasLayout };
}
