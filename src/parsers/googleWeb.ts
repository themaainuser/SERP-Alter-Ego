import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { absoluteUrl, clean, compact, isGoogleHost, parseError, parseNumber, type Selection, snakeCase, unwrapGoogleRedirect } from './common.js';

/*
 * Google's class names are obfuscated and change often, so this parser anchors on stable
 * structure instead: organic results are links wrapping an <h3>; the knowledge panel carries
 * data-attrid attributes; "People also ask" blocks carry data-q / data-initq.
 */

export interface OrganicResult {
  position: number;
  title: string;
  link: string;
  displayed_link?: string;
  favicon?: string;
  date?: string;
  snippet?: string;
  snippet_highlighted_words?: string[];
  source?: string;
}
export interface KnowledgeGraph {
  title: string;
  type?: string;
  description?: string;
  source?: { name: string; link?: string };
  website?: string;
  /** Labelled attributes of the panel (e.g. `invented`), keyed by snake_cased label. */
  [attribute: string]: unknown;
}
export interface RelatedQuestion {
  question: string;
  snippet?: string;
  title?: string;
  link?: string;
  displayed_link?: string;
}
export interface RelatedSearch {
  query: string;
  link?: string;
  serpapi_link?: string;
}
export interface Ad {
  position: number;
  block_position: 'top' | 'bottom';
  title: string;
  link: string;
  displayed_link?: string;
  snippet?: string;
}
export interface AnswerBox {
  type: 'organic_result';
  snippet: string;
  title?: string;
  link?: string;
  displayed_link?: string;
}
export interface SearchInformation {
  query_displayed?: string;
  total_results?: number;
  time_taken_displayed?: number;
  organic_results_state: string;
}
/** Keys are omitted when empty, as SerpApi does. */
export interface WebData {
  search_information: SearchInformation;
  ads?: Ad[];
  knowledge_graph?: KnowledgeGraph;
  answer_box?: AnswerBox;
  organic_results?: OrganicResult[];
  related_questions?: RelatedQuestion[];
  related_searches?: RelatedSearch[];
}
export interface WebParse {
  data: WebData;
  noResults: boolean;
  hasLayout: boolean;
}

// Blocks that contain result-like links but are not organic results.
const NON_ORGANIC =
  '#tads, #tadsb, #bottomads, [data-text-ad], #rhs, [data-initq], .related-question-pair, g-scrolling-carousel, [data-attrid], #botstuff, #brs, #foot, #appbar, [role="navigation"]';

const LEADING_DATE =
  /^((?:[A-Z][a-z]{2} \d{1,2}, \d{4})|(?:\d+ (?:second|minute|hour|day|week|month|year)s? ago))\s*[—–-]\s*/;

function normaliseCite(text: unknown): string {
  return clean(text).replace(/\s*›\s*/g, ' › ');
}

function findSnippetNode($: CheerioAPI, anchor: AnyNode): Selection | null {
  let node = $(anchor).parent();
  for (let depth = 0; depth < 8 && node.length; depth++, node = node.parent()) {
    if (node.find('a:has(h3)').length > 1) break; // climbed into a neighbouring result
    const candidate = node
      .find('[data-sncf], .VwiC3b, .lEBKkf, [style*="line-clamp"], .st')
      .filter((_, e) => !$.contains(anchor, e))
      .first();
    if (candidate.length && clean(candidate.text()).length > 15) return candidate;
  }
  return null;
}

function parseOrganic($: CheerioAPI, root: Selection, { baseUrl, start }: { baseUrl: string; start: number }): OrganicResult[] {
  const results: OrganicResult[] = [];
  const seen = new Set();
  root.find('a:has(h3)').each((_, el) => {
    const a = $(el);
    if (a.closest(NON_ORGANIC).length) return;
    const link = unwrapGoogleRedirect(a.attr('href'), baseUrl);
    const title = clean(a.find('h3').first().text());
    if (!link || !title || isGoogleHost(new URL(link).hostname) || seen.has(link)) return;
    seen.add(link);

    const snippetNode = findSnippetNode($, el);
    let snippet = snippetNode ? clean(snippetNode.text()) : undefined;
    let date: string | undefined;
    const lead = snippet ? LEADING_DATE.exec(snippet) : null;
    if (snippet && lead) {
      date = lead[1];
      snippet = snippet.slice(lead[0].length);
    }
    const highlighted = snippetNode ? [...new Set(snippetNode.find('em, b').map((__, e) => clean($(e).text())).get().filter(Boolean))] : [];
    const favicon = a.find('img').filter((__, i) => !$(i).closest('h3').length).first().attr('src');

    results.push(
      compact({
        position: start + results.length + 1,
        title,
        link,
        displayed_link: normaliseCite(a.find('cite').first().text()) || undefined,
        favicon: favicon && /^(data:|https?:)/.test(favicon) ? favicon : undefined,
        date,
        snippet,
        snippet_highlighted_words: highlighted,
        source: clean(a.find('.VuuXrf').first().text()) || undefined,
      }),
    );
  });
  return results;
}

function parseKnowledgeGraph($: CheerioAPI, baseUrl: string): KnowledgeGraph | undefined {
  const panel = $('#rhs').length ? $('#rhs') : $('body');
  const titleEl = panel.find('[data-attrid="title"]').first();
  if (!titleEl.length) return undefined;
  const descBlock = panel.find('[data-attrid="description"]').first();
  const wiki = descBlock.find('a[href*="wikipedia.org"]').first();
  const description = clean(descBlock.find('span').first().text() || descBlock.text()).replace(/\s*(Wikipedia|More)$/, '');
  const website = panel.find('a[href]').filter((_, a) => clean($(a).text()) === 'Website').first();

  const kg: KnowledgeGraph = {
    title: clean(titleEl.text()),
    type: clean(panel.find('[data-attrid="subtitle"]').first().text()),
    description: description || undefined,
    source: wiki.length ? { name: 'Wikipedia', link: absoluteUrl(wiki.attr('href'), baseUrl) ?? undefined } : undefined,
    website: absoluteUrl(website.attr('href'), baseUrl) || undefined,
  };
  panel.find('[data-attrid^="kc:/"]').each((_, el) => {
    const label = clean($(el).find('.w8qArf').first().text());
    const value = clean($(el).find('.LrzXr, .kno-fv').first().text());
    const key = snakeCase(label);
    if (key && value && !(key in kg)) kg[key] = value;
  });
  return compact(kg);
}

function parseRelatedQuestions($: CheerioAPI, baseUrl: string): RelatedQuestion[] {
  const out: RelatedQuestion[] = [];
  const seen = new Set();
  $('.related-question-pair, [data-initq]').each((_, el) => {
    const block = $(el);
    const question = clean(block.attr('data-q') || block.find('[role="heading"]').first().text());
    if (!question || seen.has(question)) return;
    seen.add(question);
    const link = unwrapGoogleRedirect(block.find('a:has(h3)').first().attr('href'), baseUrl);
    out.push(
      compact({
        question,
        snippet: clean(block.find('.hgKElc, .LGOjhe, [data-sncf]').first().text()) || undefined,
        title: clean(block.find('h3').first().text()) || undefined,
        link: link || undefined,
        displayed_link: normaliseCite(block.find('cite').first().text()) || undefined,
      }),
    );
  });
  return out;
}

function parseRelatedSearches($: CheerioAPI, baseUrl: string, query: string): Array<{ query: string; link: string | null; _q: string }> {
  const out: Array<{ query: string; link: string | null; _q: string }> = [];
  const seen = new Set();
  $('#botstuff a[href], #brs a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!/^\/search\?/.test(href) || $(el).attr('id') === 'pnnext') return;
    const q = new URL(href, baseUrl).searchParams.get('q');
    const text = clean($(el).text());
    if (!q || !text || q === query || seen.has(q) || /^\d+$/.test(text) || /^(next|previous)$/i.test(text)) return;
    seen.add(q);
    out.push({ query: text, link: absoluteUrl(href, baseUrl), _q: q });
  });
  return out;
}

function parseAds($: CheerioAPI, baseUrl: string): Ad[] {
  const ads: Ad[] = [];
  $('[data-text-ad]').each((_, el) => {
    const ad = $(el);
    const a = ad.find('a[href]').first();
    const title = clean(ad.find('[role="heading"]').first().text());
    const link = absoluteUrl(ad.find('a[data-pcu]').first().attr('data-pcu')?.split(',')[0] || a.attr('href'), baseUrl);
    if (!title || !link) return;
    ads.push(
      compact({
        position: ads.length + 1,
        block_position: ad.closest('#tads').length ? 'top' : 'bottom',
        title,
        link,
        displayed_link: normaliseCite(ad.find('cite, .x2VHCd').first().text()) || undefined,
        snippet: clean(ad.find('.MUxGbd, [style*="line-clamp"]').first().text()) || undefined,
      }),
    );
  });
  return ads;
}

function parseFeaturedSnippet($: CheerioAPI, baseUrl: string): AnswerBox | undefined {
  const box = $('.hgKElc, [data-attrid="wa:/description"]').not('[data-initq] *, .related-question-pair *').first();
  const text = clean(box.text());
  if (!text) return undefined;
  const container = box.closest('.g, .MjjYud, [data-hveid]');
  const a = container.find('a:has(h3)').first();
  const link = unwrapGoogleRedirect(a.attr('href'), baseUrl);
  return compact<AnswerBox>({
    type: 'organic_result',
    snippet: text,
    title: clean(a.find('h3').first().text()) || undefined,
    link: link || undefined,
    displayed_link: normaliseCite(a.find('cite').first().text()) || undefined,
  });
}

/**
 * Parse a rendered Google web results page.
 * `buildSerpApiLink(query)` turns a related-search query into a local serpapi_link.
 */
export function parseGoogleWeb(
  html: string,
  { baseUrl = 'https://www.google.com', start = 0, query = '', buildSerpApiLink }: { baseUrl?: string; start?: number; query?: string; buildSerpApiLink?: (query: string) => string } = {},
): WebParse {
  const $ = cheerio.load(html);
  const hasLayout = $('#search, #rso, #main, #center_col, #result-stats, #botstuff').length > 0;
  const root = $('#rso').length ? $('#rso') : $('#search').length ? $('#search') : $('body');

  const organic = parseOrganic($, root, { baseUrl, start });
  const bodyText = clean($('body').text());
  const noResults = /did not match any documents|No results found for|Your search .* did not match/i.test(bodyText);
  if (!organic.length && !hasLayout && !noResults) {
    throw parseError('Google results page was not recognised (no results container found); the layout may have changed or the page did not finish rendering.');
  }

  const statsText = clean($('#result-stats').text());
  const total = /([\d][\d,.\s]*)\s+results?/i.exec(statsText);
  const time = /\(([\d.,]+)\s+seconds?\)/i.exec(statsText);
  const displayed = clean($('textarea[name="q"], input[name="q"]').first().val() || $('textarea[name="q"]').first().text());

  const data: WebData = {
    search_information: compact({
      query_displayed: displayed || query || undefined,
      total_results: total ? (parseNumber(total[1]) ?? undefined) : undefined,
      time_taken_displayed: time?.[1] ? Number(time[1].replace(',', '.')) : undefined,
      organic_results_state: organic.length ? 'Results for exact spelling' : 'Fully empty',
    }),
    ads: parseAds($, baseUrl),
    knowledge_graph: parseKnowledgeGraph($, baseUrl),
    answer_box: parseFeaturedSnippet($, baseUrl),
    organic_results: organic,
    related_questions: parseRelatedQuestions($, baseUrl),
  };
  const related = parseRelatedSearches($, baseUrl, query);
  data.related_searches = related.map(({ query: q, link, _q }) =>
    compact({ query: q, link: link ?? undefined, serpapi_link: buildSerpApiLink ? buildSerpApiLink(_q) : undefined }),
  );
  return { data: compact(data), noResults: !organic.length && noResults, hasLayout };
}
