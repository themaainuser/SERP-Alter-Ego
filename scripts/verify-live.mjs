/**
 * Verify parsers against captured live pages (test/fixtures/live/*.html).
 *
 * For each surface it counts what the raw DOM offers (candidate nodes per parser anchor)
 * next to what the parser extracted, so selector drift shows up as a coverage gap rather
 * than a silent zero. Also reports per-field fill rates and runs the synthetic fixtures
 * for contrast. Exits non-zero when a live page yields zero results.
 *
 * Run: npm run verify:live       (after npm run capture)
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { findPrice, isEncryptedRedirect, textLines } from '../src/parsers/common.js';
import { parseGoogleWeb } from '../src/parsers/googleWeb.js';
import { parseImages } from '../src/parsers/googleImages.js';
import { parseShopping } from '../src/parsers/googleShopping.js';
import { parseSearchNews } from '../src/parsers/googleNews.js';

const LIVE = path.resolve('test/fixtures/live');
const SYNTH = path.resolve('test/fixtures');

// Mirrors of parser-internal anchors, used only for DOM-side candidate counting.
const NON_ORGANIC =
  '#tads, #tadsb, #bottomads, [data-text-ad], #rhs, [data-initq], .related-question-pair, g-scrolling-carousel, [data-attrid], #botstuff, #brs, #foot, #appbar, [role="navigation"]';
const SHOP_CARDS = '[data-docid], .sh-dgr__grid-result, .sh-dlr__list-result, .i0X6df, .KZmu8e, .LrTUQ, div[role="listitem"]';

const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '—');
const fill = (items, key) => pct(items.filter((r) => r[key] !== undefined && r[key] !== '').length, items.length);
const line = (label, dom, parsed) =>
  console.log(`  ${label.padEnd(28)} dom=${String(dom).padStart(4)}  parsed=${String(parsed).padStart(4)}  coverage=${pct(parsed, dom)}`);

function reportWeb(file) {
  const html = readFileSync(file, 'utf8');
  const { data } = parseGoogleWeb(html);
  const $ = cheerio.load(html);
  const root = $('#rso').length ? $('#rso') : $('#search');
  const candidates = root.find('a:has(h3)').filter((_, el) => !$(el).closest(NON_ORGANIC).length).length;
  const organic = data.organic_results ?? [];
  console.log(`\nWEB        ${path.basename(file)}`);
  line('organic (a:has(h3))', candidates, organic.length);
  line('people also ask', $('[data-initq], .related-question-pair').length, data.related_questions?.length ?? 0);
  line('ads ([data-text-ad])', $('[data-text-ad]').length, data.ads?.length ?? 0);
  line('knowledge graph', $('[data-attrid="title"]').length, data.knowledge_graph ? 1 : 0);
  line('answer box (.hgKElc)', $('.hgKElc').not('[data-initq] *, .related-question-pair *').length, data.answer_box ? 1 : 0);
  line('related searches', $('#botstuff a[href], #brs a[href]').filter((_, a) => /^\/search\?/.test($(a).attr('href') || '')).length, data.related_searches?.length ?? 0);
  console.log(
    `  fill: snippet=${fill(organic, 'snippet')} displayed_link=${fill(organic, 'displayed_link')} source=${fill(organic, 'source')} date=${fill(organic, 'date')}`,
  );
  const gotoKept = organic.filter((r) => isEncryptedRedirect(r.link)).length;
  console.log(`  stats: total_results=${data.search_information.total_results ?? '—'}  encrypted /goto links kept for server-side resolution=${gotoKept}`);
  return organic.length;
}

function reportImages(file) {
  const html = readFileSync(file, 'utf8');
  const { images_results: results } = parseImages(html);
  const $ = cheerio.load(html);
  const tiles = $('[data-lpage]').filter((_, el) => !$(el).find('[data-lpage]').length);
  const uniquePages = new Set();
  tiles.each((_, el) => {
    const raw = $(el).attr('data-lpage');
    if (!raw) return;
    try {
      const u = new URL(raw, 'https://www.google.com');
      if (!/(^|\.)google\.[a-z.]+$/i.test(u.hostname)) uniquePages.add(u.href);
    } catch {
      /* unparseable data-lpage — not a candidate */
    }
  });
  console.log(`\nIMAGES     ${path.basename(file)}`);
  console.log(`  fully-rendered /imgres tiles: ${$('a[href*="/imgres?"]').length} (carry originals; the rest of the grid is lazy; ${tiles.length} lazy tiles -> ${uniquePages.size} unique destination pages)`);
  line('tiles (unique pages)', uniquePages.size, results.length);
  console.log(`  fill: title=${fill(results, 'title')} source=${fill(results, 'source')} thumbnail=${fill(results, 'thumbnail')} link=${fill(results, 'link')}`);
  return results.length;
}

function reportShopping(file) {
  const html = readFileSync(file, 'utf8');
  const { shopping_results: results } = parseShopping(html);
  const $ = cheerio.load(html);
  const cards = $(SHOP_CARDS).filter((_, el) => !$(el).find(SHOP_CARDS).length);
  const withPrice = cards.filter((_, el) => textLines($(el)).some((l) => findPrice(l)));
  const withTitle = withPrice.filter((_, el) =>
    textLines($(el)).some((l) => l.length > 12 && !findPrice(l) && !/(free (delivery|shipping)|delivery|shipping|pickup|in stock)/i.test(l)),
  );
  console.log(`\nSHOPPING  ${path.basename(file)}`);
  line('product cards (price+title)', withTitle.length, results.length);
  console.log(`  card-role nodes: ${cards.length}; price-bearing: ${withPrice.length}; the gaps are refinement chips, promo widgets and same-product re-renders (parser dedupes by design)`);
  console.log(
    `  fill: source=${fill(results, 'source')} rating=${fill(results, 'rating')} reviews=${fill(results, 'reviews')} delivery=${fill(results, 'delivery')} tag=${fill(results, 'tag')} old_price=${fill(results, 'old_price')} thumbnail=${fill(results, 'thumbnail')}`,
  );
  return results.length;
}

function reportNewsTab(file) {
  const html = readFileSync(file, 'utf8');
  const { news_results: results } = parseSearchNews(html);
  const $ = cheerio.load(html);
  const root = $('#rso').length ? $('#rso') : $('#search');
  const candidates = root
    .find('a[href]:has([role="heading"])')
    .filter((_, a) => !/(^|\.)google\./.test(new URL(unwrapSafe($(a).attr('href'))).hostname))
    .length;
  console.log(`\nNEWS TAB  ${path.basename(file)}`);
  line('story anchors', candidates, results.length);
  console.log(`  fill: source=${fill(results, 'source')} snippet=${fill(results, 'snippet')} date=${fill(results, 'date')} thumbnail=${fill(results, 'thumbnail')}`);
  return results.length;
}
function unwrapSafe(href) {
  try {
    return new URL(href || 'https://example.com').href;
  } catch {
    return 'https://example.com';
  }
}

const SURFACES = [
  { match: /^web-/, run: reportWeb },
  { match: /^images/, run: reportImages },
  { match: /^shopping/, run: reportShopping },
  { match: /^news-tab/, run: reportNewsTab },
];

if (!existsSync(LIVE)) {
  console.error(`No live fixtures at ${LIVE}. Run: npm run capture`);
  process.exit(1);
}
const live = readdirSync(LIVE).filter((f) => f.endsWith('.html'));
if (!live.length) {
  console.error(`No live fixtures in ${LIVE}. Run: npm run capture`);
  process.exit(1);
}

console.log('=== LIVE fixtures (real captured pages) ===');
const failures = [];
for (const file of live.sort()) {
  const surface = SURFACES.find((s) => s.match.test(file));
  if (!surface) continue;
  try {
    if (surface.run(path.join(LIVE, file)) === 0) failures.push(file);
  } catch (err) {
    console.log(`\n${file}: PARSER THREW -> ${err.message}`);
    failures.push(file);
  }
}

console.log('\n=== SYNTHETIC fixtures (pre-existing, for contrast) ===');
for (const [file, run] of [
  ['web-serp.html', reportWeb],
  ['images.html', reportImages],
  ['shopping.html', reportShopping],
  ['news-tab.html', reportNewsTab],
]) {
  try {
    run(path.join(SYNTH, file));
  } catch (err) {
    console.log(`\n${file}: PARSER THREW -> ${err.message}`);
  }
}

console.log(`\n${failures.length ? `FAIL: ${failures.join(', ')} yielded zero results or threw.` : 'PASS: every live page produced results.'}`);
process.exit(failures.length ? 1 : 0);
