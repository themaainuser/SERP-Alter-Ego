import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { absoluteUrl, clean, compact, isEncryptedRedirect, isGoogleHost, parseError, parseNumber, type Selection, snakeCase, unwrapGoogleRedirect } from './common.js';

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
/** One block of Google's AI Overview, in SerpApi's `ai_overview.text_blocks` shape. */
export interface AiTextBlock {
  type: 'paragraph' | 'heading' | 'list' | 'table';
  snippet?: string;
  list?: AiListItem[];
  table?: string[][];
  /** 1-based positions into `ai_overview.references`, matching Google's on-page badges. */
  reference_indexes?: number[];
  snippet_highlighted_words?: string[];
}
export interface AiListItem {
  title?: string;
  snippet?: string;
  reference_indexes?: number[];
}
export interface AiReference {
  index: number;
  title: string;
  link: string;
  source?: string;
}
/** SerpApi's `ai_overview`: ordered blocks plus the flat citation list they point into. */
export interface AiOverview {
  text_blocks: AiTextBlock[];
  references: AiReference[];
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
  ai_overview?: AiOverview;
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
    const href = a.attr('href');
    const link = unwrapGoogleRedirect(href, baseUrl);
    const title = clean(a.find('h3').first().text());
    // Encrypted /goto links are real results whose destination the engine resolves
    // server-side; every other google-host link (ads, internal nav) is not organic.
    if (!link || !title || seen.has(link) || (isGoogleHost(new URL(link).hostname) && !isEncryptedRedirect(href, baseUrl))) return;
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

// ---------------------------------------------------------------------------
// AI Overview
//
// The block's *content* lives in a turn-scoped container (`div[data-scope-id="turn"]`,
// observed identical across 2026-10 captures; the "AI Overview" title row, prose blocks,
// heading/list/table sections, citation anchors and a sources strip). Content that "Show
// more" reveals ships hidden behind Google's `.RVppL`/`display:none` markers — so when the
// browser step expands the block before capture, the same walk picks the extra paragraphs
// up automatically, and an unexpanded capture simply yields the preview.
// ---------------------------------------------------------------------------

// UI chrome that ships inside the block but is never answer content: scripts/styles/icons,
// toasts (`aria-live` status/alert regions) and the share dialog (`role="dialog"`).
const AI_SKIP = 'script, style, svg, button, noscript, template, iframe, [role="dialog"], [role="alert"], [role="status"], [aria-live]';

/** True when the element is hidden by markup (not by a stylesheet we cannot see). */
function hiddenByMarkup($: CheerioAPI, el: AnyNode): boolean {
  if ($(el).attr('hidden') !== undefined) return true;
  const style = $(el).attr('style') || '';
  if (/display:\s*none/i.test(style)) return true;
  // `.RVppL` is Google's "hidden until expanded" marker (its stylesheet ships
  // `.RVppL{display:none}`); an inline visible display overrides it.
  if (/\bRVppL\b/.test($(el).attr('class') || '') && !/display:\s*(block|inline|flex|grid|contents|list-item)/i.test(style)) return true;
  return false;
}

/** Hidden anywhere up the ancestor chain (or is itself hidden). */
function hiddenDeep($: CheerioAPI, el: AnyNode): boolean {
  let hidden = false;
  $(el).parents().addBack().each((_, n) => {
    if (hiddenByMarkup($, n)) hidden = true;
  });
  return hidden;
}

/** A copy of the subtree with scripts/icons/hidden content stripped — i.e. what a reader sees. */
function visibleClone($: CheerioAPI, el: AnyNode): Selection {
  const clone = $(el).clone();
  if (!hiddenByMarkup($, el)) {
    clone.find(AI_SKIP).remove();
    clone.find('*').each((_, n) => {
      if (hiddenByMarkup($, n)) $(n).remove();
    });
  } else {
    clone.remove();
  }
  return clone;
}

const visibleText = ($: CheerioAPI, el: AnyNode): string => clean(visibleClone($, el).text());

/** Citation anchors are labelled links to a destination (encrypted /goto, /url or direct). */
function isCitationHref(href: string | undefined, baseUrl: string): boolean {
  if (!href || /^(#|javascript:|mailto:)/i.test(href)) return false;
  const abs = absoluteUrl(href, baseUrl);
  if (!abs) return false;
  try {
    const u = new URL(abs);
    if (!isGoogleHost(u.hostname)) return true;
    return u.pathname === '/goto' || u.pathname === '/url';
  } catch {
    return false;
  }
}

/** `https://en.wikipedia.org/...` -> `en.wikipedia.org`; encrypted redirects yield undefined. */
export function linkSource(abs: string): string | undefined {
  try {
    const u = new URL(abs);
    return isGoogleHost(u.hostname) ? undefined : u.hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

function findAiRoot($: CheerioAPI): Selection | undefined {
  const turn = $('div[data-scope-id="turn"]')
    .filter((_, el) => !hiddenDeep($, el) && $(el).text().length >= 60)
    .first();
  if (turn.length) return turn;
  const heading = $('[role="heading"]')
    .filter((_, el) => /^AI Overview:?$/i.test(clean($(el).text())))
    .first();
  if (heading.length) {
    const box = heading.closest('[data-scope-id], div.qRuFed, div.CKgc1d');
    if (box.length) return box;
  }
  const fallback = $('div.qRuFed, div.CKgc1d').filter((_, el) => !hiddenDeep($, el) && $(el).text().length >= 60).first();
  return fallback.length ? fallback : undefined;
}

/**
 * Extract `ai_overview` (SerpApi shape) from a rendered page. Returns undefined when the
 * page has no AI Overview. Walks the block in DOM order emitting paragraph / heading /
 * list / table blocks; link-heavy rows (the sources strip) are left to `references`.
 */
function parseAiOverview($: CheerioAPI, baseUrl: string): AiOverview | undefined {
  const root = findAiRoot($);
  if (!root) return undefined;

  // References first: every labelled citation anchor, in DOM order (inline citations in the
  // prose come first, so 1..n matches Google's badge order closely).
  const references: AiReference[] = [];
  const refIndex = new Map<string, number>();
  root.find('a[href]').each((_, el) => {
    if (hiddenDeep($, el)) return;
    const a = $(el);
    const href = a.attr('href');
    const label = clean(a.attr('aria-label') || a.text());
    if (!label || !isCitationHref(href, baseUrl)) return;
    const abs = absoluteUrl(href, baseUrl);
    if (!abs || refIndex.has(abs)) return;
    refIndex.set(abs, references.length + 1);
    references.push({ index: references.length + 1, title: label, link: abs, source: linkSource(abs) });
  });

  const blocks: AiTextBlock[] = [];
  const indexes = (el: AnyNode): number[] | undefined => {
    const out = new Set<number>();
    $(el)
      .find('a[href]')
      .each((_, a) => {
        if (hiddenDeep($, a)) return;
        const abs = absoluteUrl($(a).attr('href'), baseUrl);
        const i = abs ? refIndex.get(abs) : undefined;
        if (i) out.add(i);
      });
    return out.size ? [...out].sort((x, y) => x - y) : undefined;
  };

  function pushList(el: AnyNode): void {
    const items: AiListItem[] = [];
    $(el)
      .find('li')
      .each((_, li) => {
        if (hiddenDeep($, li)) return;
        // Google's "cobrowse" card link marks whole source/question chips (the strip beside
        // the answer). Their labels live in spans outside the empty-text anchor, so this is
        // the reliable tell — such items duplicate `references` and are not prose.
        if ($(li).find('a[data-link-behavior]').length) return;
        const clone = visibleClone($, li);
        clone.children('ul, ol').remove(); // nested items are emitted as their own entries
        const itemText = clean(clone.text()) || undefined;
        // Also drop items that are mostly their links' own text (other chip-row shapes).
        const linkChars = clone
          .find('a')
          .map((__, a) => clean($(a).text()).length)
          .get()
          .reduce((sum, n) => sum + n, 0);
        if (itemText && linkChars / itemText.length > 0.6) return;
        const t = clone.children('b, strong, [role="heading"]').first();
        let title: string | undefined;
        if (t.length && clean(t.text()).length <= 60) {
          title = clean(t.text());
          t.remove();
        }
        // The separator colon sits outside the bold title in Google's markup — fold it away
        // so `title`/`snippet` match SerpApi's split.
        const snippet = (clean(clone.text()) || undefined)?.replace(/^[:\-\s]+/, '') || undefined;
        if (!title && !snippet) return;
        items.push(compact({ title, snippet, reference_indexes: indexes(li) }));
      });
    if (items.length) blocks.push(compact({ type: 'list', list: items }));
  }

  function pushTable(el: AnyNode): void {
    const rows: string[][] = [];
    $(el)
      .find('tr')
      .each((_, tr) => {
        if (hiddenDeep($, tr)) return;
        const cells: string[] = [];
        $(tr)
          .children('th, td')
          .each((__, td) => {
            cells.push(clean($(td).text()));
          });
        if (cells.some(Boolean)) rows.push(cells);
      });
    if (rows.length) blocks.push(compact({ type: 'table', table: rows }));
  }

  function visit(el: AnyNode): void {
    const node = $(el);
    if (node.is(AI_SKIP) || hiddenDeep($, el)) return;
    const txt = visibleText($, el);
    if (!txt || /^AI Overview:?$/i.test(txt)) return; // empty subtree / the block's own title row

    if (node.is('[role="heading"], h1, h2, h3, h4, h5, h6')) {
      blocks.push(compact({ type: 'heading', snippet: txt, reference_indexes: indexes(el) }));
      return;
    }
    const tag = 'tagName' in el ? el.tagName.toLowerCase() : '';
    if (tag === 'ul' || tag === 'ol') return pushList(el);
    if (tag === 'table') return pushTable(el);

    if (tag === 'div' || tag === 'p' || tag === 'section' || tag === 'article' || tag === 'aside') {
      const kids = node
        .children('div, p, ul, ol, table, h1, h2, h3, h4, h5, h6, section, article, [role="heading"]')
        .filter((_, k) => !hiddenDeep($, k));
      // Structural children (headings/lists/tables) always carry content, however short;
      // prose wrappers only count when they hold a meaningful chunk of text.
      const content = kids.filter((_, k) => {
        const kn = $(k);
        if (kn.is('[role="heading"], h1, h2, h3, h4, h5, h6, ul, ol, table')) return true;
        return visibleText($, k).length >= 20;
      });
      if (content.length) {
        content.each((__, k) => visit(k)); // children carry the content; nothing at this level
        return;
      }
      if (txt.length < 30) return; // widget/whitespace debris
      // A row of chips/links (the sources strip) is citations, not prose.
      const linkChars = node
        .find('a')
        .filter((_, a) => !hiddenDeep($, a))
        .map((__, a) => clean($(a).text()).length)
        .get()
        .reduce((sum, n) => sum + n, 0);
      if (txt.length && linkChars / txt.length > 0.6) return;
      const marks = [...new Set(node.find('mark').filter((__, m) => !hiddenDeep($, m)).map((__, m) => clean($(m).text())).get())].filter(Boolean);
      blocks.push(
        compact({
          type: 'paragraph',
          snippet: txt,
          reference_indexes: indexes(el),
          snippet_highlighted_words: marks.length ? marks : undefined,
        }),
      );
      return;
    }
    // Anything else (span, a, img, …): not structural — visit element children so wrappers
    // around real content still get reached.
    node.children().each((__, c) => visit(c));
  }

  root.children().each((_, child) => visit(child));
  if (!blocks.length && !references.length) return undefined;
  return { text_blocks: blocks, references };
}

/**
 * Collapse references that ended up pointing at the same destination — an inline citation
 * and a strip chip for one source carry different `/goto` blobs — then renumber 1..n so the
 * list stays contiguous (SerpApi lists each source once). Call AFTER link resolution, so
 * duplicates are only merged when both links were resolved to a real destination; unresolved
 * (`/goto`) links cannot be compared and are left alone.
 */
export function dedupeAiReferences(aio: AiOverview): void {
  const byDest = new Map<string, number>(); // resolved destination -> its first index
  const collapse = new Map<number, number>(); // later index -> the first index
  for (const ref of aio.references) {
    if (!linkSource(ref.link)) continue; // still an encrypted/google link — no destination known
    const first = byDest.get(ref.link);
    if (first === undefined) byDest.set(ref.link, ref.index);
    else collapse.set(ref.index, first);
  }
  if (!collapse.size) return;

  aio.references = aio.references.filter((r) => !collapse.has(r.index));
  const finalIndex = new Map<number, number>();
  aio.references.forEach((r, i) => {
    finalIndex.set(r.index, i + 1);
    r.index = i + 1;
  });
  const fix = (arr: number[] | undefined): number[] | undefined => {
    if (!arr?.length) return undefined;
    const out = [...new Set(arr.map((i) => finalIndex.get(collapse.get(i) ?? i) ?? i))].filter((i) => i > 0);
    return out.length ? out : undefined;
  };
  for (const block of aio.text_blocks) {
    block.reference_indexes = fix(block.reference_indexes);
    for (const item of block.list ?? []) item.reference_indexes = fix(item.reference_indexes);
  }
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
    ai_overview: parseAiOverview($, baseUrl),
    organic_results: organic,
    related_questions: parseRelatedQuestions($, baseUrl),
  };
  const related = parseRelatedSearches($, baseUrl, query);
  data.related_searches = related.map(({ query: q, link, _q }) =>
    compact({ query: q, link: link ?? undefined, serpapi_link: buildSerpApiLink ? buildSerpApiLink(_q) : undefined }),
  );
  return { data: compact(data), noResults: !organic.length && noResults, hasLayout };
}
