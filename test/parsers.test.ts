import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defined } from './helpers/assertions.js';
import { fixture } from './helpers/fakeUpstream.js';
import { parseGoogleWeb } from '../src/parsers/googleWeb.js';
import { parseNewsPage, parseNewsRss, parseSearchNews } from '../src/parsers/googleNews.js';
import { parseShopping } from '../src/parsers/googleShopping.js';
import { parseImages } from '../src/parsers/googleImages.js';
import { containsGraph, decodeBatchExecute, type EmptyFinanceResult, extractDataBlocks, type FinanceResult, parseFinance } from '../src/parsers/googleFinance.js';
import { findPrice, normalizeAmount, unwrapGoogleRedirect } from '../src/parsers/common.js';

const NOW = 1790852000000; // fixture capture time (2026-10-01T11:13Z)

/** Narrow a finance parse to a real result (not the "unknown symbol" marker). */
function expectResult(parsed: FinanceResult | EmptyFinanceResult): FinanceResult {
  if (parsed.empty) throw new Error('expected a finance result, got the empty marker');
  return parsed;
}

describe('google web parser', () => {
  const { data, hasLayout } = parseGoogleWeb(fixture('web-serp.html'), {
    query: 'best coffee grinder',
    buildSerpApiLink: (q) => `http://local/search.json?q=${encodeURIComponent(q)}`,
  });

  const organic = defined(data.organic_results, 'organic_results');
  const kg = defined(data.knowledge_graph, 'knowledge_graph');
  const questions = defined(data.related_questions, 'related_questions');
  const searches = defined(data.related_searches, 'related_searches');
  const ads = defined(data.ads, 'ads');
  const answer = defined(data.answer_box, 'answer_box');

  it('extracts organic results with SerpApi field names', () => {
    assert.equal(hasLayout, true);
    assert.equal(organic.length, 3);
    const [first, second, third] = organic;
    assert.deepEqual(
      { position: first.position, title: first.title, link: first.link, displayed_link: first.displayed_link, source: first.source },
      { position: 1, title: 'Best Coffee Grinders of 2026', link: 'https://www.example.com/best-grinders', displayed_link: 'https://www.example.com › best-grinders', source: 'Example Reviews' },
    );
    assert.equal(first.date, 'Mar 3, 2026');
    assert.match(String(first.snippet), /^We tested a dozen coffee grinders/);
    assert.deepEqual(first.snippet_highlighted_words, ['coffee', 'grinders']);
    assert.match(String(first.favicon), /^data:image/);
    // /url?q= redirect wrappers are unwrapped; google-internal and duplicate links are dropped.
    assert.equal(second.link, 'https://blog.example.org/grind-guide');
    assert.match(String(second.snippet), /^From espresso to French press/);
    assert.equal(third.link, 'https://www.example.com/burr-vs-blade');
    assert.equal(third.position, 3);
  });

  it('honours the start offset when numbering positions', () => {
    const page2 = parseGoogleWeb(fixture('web-serp.html'), { start: 10 }).data;
    assert.equal(defined(page2.organic_results)[0]?.position, 11);
  });

  it('extracts search information', () => {
    assert.deepEqual(data.search_information, {
      query_displayed: 'best coffee grinder',
      total_results: 1230000,
      time_taken_displayed: 0.52,
      organic_results_state: 'Results for exact spelling',
    });
  });

  it('extracts the knowledge graph', () => {
    assert.equal(kg.title, 'Coffee grinder');
    assert.equal(kg.type, 'Kitchen appliance');
    assert.match(String(kg.description), /^A coffee grinder is a device/);
    assert.deepEqual(kg.source, { name: 'Wikipedia', link: 'https://en.wikipedia.org/wiki/Burr_mill' });
    assert.equal(kg.website, 'https://grinders.example.com/');
    assert.equal(kg.invented, '15th century');
  });

  it('extracts related questions, related searches, ads and the answer box', () => {
    assert.equal(questions[0].question, 'How fine should coffee be ground?');
    assert.equal(questions[0].link, 'https://www.example.net/grind');
    assert.deepEqual(searches.map((r) => r.query), ['burr coffee grinder', 'manual coffee grinder']);
    assert.equal(searches[0].serpapi_link, 'http://local/search.json?q=burr%20coffee%20grinder');
    assert.equal(ads[0].title, 'Top Burr Grinders - 20% Off');
    assert.equal(ads[0].link, 'https://ads.example.com/grinders');
    assert.equal(ads[0].block_position, 'top');
    assert.match(answer.snippet, /Burr grinders produce a more uniform grind/);
  });

  it('reports "no results" as a valid empty page, not a parse failure', () => {
    const empty = parseGoogleWeb(fixture('web-serp-empty.html'), { query: 'zzzxqv' });
    assert.equal(empty.noResults, true);
    assert.equal(empty.data.organic_results, undefined);
  });

  it('throws PARSE_ERROR when the page layout is unrecognised', () => {
    assert.throws(() => parseGoogleWeb('<html><body><p>Something else entirely</p></body></html>'), { code: 'PARSE_ERROR' });
  });
});

describe('google news parsers', () => {
  it('parses the real RSS feed fixture', () => {
    const { news_results } = parseNewsRss(fixture('news-rss-coffee.xml'));
    assert.equal(news_results.length, 6);
    const first = news_results[0];
    assert.equal(first.position, 1);
    assert.equal(first.title, 'Breville’s New Coffee Maker Brings Pour-Over Coffee To One-Touch Brewing');
    assert.equal(first.source?.name, 'Forbes');
    assert.match(first.link, /^https:\/\/news\.google\.com\/rss\/articles\//);
    assert.equal(first.iso_date, '2026-09-30T16:39:36.000Z');
    assert.equal(first.date, '09/30/2026, 04:39 PM, +0000 UTC');
  });

  it('collects clustered stories from RSS descriptions', () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><item><title>Main story - Alpha</title><link>https://n/1</link><pubDate>Wed, 30 Sep 2026 16:39:36 GMT</pubDate><description>&lt;ol&gt;&lt;li&gt;&lt;a href="https://n/1"&gt;Main story&lt;/a&gt;&amp;nbsp;&lt;font&gt;Alpha&lt;/font&gt;&lt;/li&gt;&lt;li&gt;&lt;a href="https://n/2"&gt;Related story&lt;/a&gt;&amp;nbsp;&lt;font&gt;Beta&lt;/font&gt;&lt;/li&gt;&lt;/ol&gt;</description><source url="https://alpha.example">Alpha</source></item></channel></rss>`;
    const [item] = parseNewsRss(xml).news_results;
    assert.equal(item.title, 'Main story');
    assert.deepEqual(item.stories, [{ title: 'Related story', link: 'https://n/2', source: { name: 'Beta' } }]);
  });

  it('throws PARSE_ERROR when the body is not an RSS feed', () => {
    assert.throws(() => parseNewsRss('<html>nope</html>'), { code: 'PARSE_ERROR' });
    assert.throws(() => parseNewsRss('not xml at all'), { code: 'PARSE_ERROR' });
  });

  it('parses the rendered news.google.com page and de-duplicates articles', () => {
    const { news_results } = parseNewsPage(fixture('news-page.html'));
    assert.equal(news_results.length, 2);
    assert.equal(news_results[0].title, 'Coffee prices hit a ten-year high as harvests falter');
    assert.equal(news_results[0]?.source?.name, 'Reuters');
    assert.equal(news_results[0].iso_date, '2026-09-30T16:39:36.000Z');
    assert.match(String(news_results[0]?.thumbnail), /^https:\/\/news\.google\.com\/api\/attachments/);
    assert.equal(news_results[1]?.source?.name, 'Local Paper');
  });

  it('parses the news tab of a regular Google search', () => {
    const { news_results } = parseSearchNews(fixture('news-tab.html'));
    assert.equal(news_results.length, 2);
    assert.deepEqual(
      { title: news_results[0].title, source: news_results[0].source, snippet: news_results[0].snippet, date: news_results[0].date },
      { title: 'Coffee prices surge to a record high', source: 'Example News', snippet: 'Arabica futures climbed again this week.', date: '3 hours ago' },
    );
    assert.equal(news_results[1].link, 'https://daily.example.org/barista-champion');
  });
});

describe('google shopping parser', () => {
  const { shopping_results } = parseShopping(fixture('shopping.html'));

  it('extracts products and skips cards without a price', () => {
    assert.equal(shopping_results.length, 2);
    const p = shopping_results[0];
    assert.equal(p.position, 1);
    assert.equal(p.title, 'Breville Barista Express Espresso Machine');
    assert.equal(p.price, '$599.95');
    assert.equal(p.extracted_price, 599.95);
    assert.equal(p.old_price, '$749.95');
    assert.equal(p.extracted_old_price, 749.95);
    assert.equal(p.source, 'Best Buy');
    assert.equal(p.rating, 4.6);
    assert.equal(p.reviews, 2310);
    assert.equal(p.delivery, 'Free delivery');
    assert.equal(p.tag, '20% off');
    assert.equal(p.link, 'https://www.bestbuy.com/site/breville/1111.p');
    assert.match(String(p.product_link), /^https:\/\/www\.google\.com\/shopping\/product\/1111/);
    assert.equal(p.product_id, '1111');
    assert.match(String(p.thumbnail), /^https:\/\/encrypted-tbn0\.gstatic\.com/);
  });

  it('understands European price formatting', () => {
    assert.equal(shopping_results[1].price, '€1.249,00');
    assert.equal(shopping_results[1].extracted_price, 1249);
  });

  it('throws PARSE_ERROR for an unrecognised page', () => {
    assert.throws(() => parseShopping('<html><body>hello</body></html>'), { code: 'PARSE_ERROR' });
  });
});

describe('google images parser', () => {
  it('extracts originals, sizes and sources from /imgres links', () => {
    const { images_results, suggested_searches } = parseImages(fixture('images.html'), { query: 'coffee' });
    assert.equal(images_results.length, 2);
    assert.deepEqual(
      { ...images_results[0], thumbnail: images_results[0]?.thumbnail?.slice(0, 10) },
      {
        position: 1,
        thumbnail: 'data:image',
        related_content_id: 'T1',
        source: 'Site Example',
        title: 'Roasted coffee beans',
        link: 'https://site.example.com/beans',
        original: 'https://cdn.example.com/beans.jpg',
        original_width: 1200,
        original_height: 800,
      },
    );
    assert.equal(images_results[1].source, 'other.example.org');
    assert.equal(images_results[1].original, 'https://cdn.example.org/latte.png');
    assert.deepEqual(suggested_searches.map((s) => s.name), ['Cup']);
  });

  it('falls back to data-lpage tiles and honours start', () => {
    const html = '<div id="search"><div data-lpage="https://a.example/p"><img src="https://encrypted-tbn0.gstatic.com/x" alt="A"></div></div>';
    const { images_results } = parseImages(html, { start: 100 });
    assert.equal(images_results[0].position, 101);
    assert.equal(images_results[0].link, 'https://a.example/p');
  });

  it('throws PARSE_ERROR for an unrecognised page', () => {
    assert.throws(() => parseImages('<html><body>nothing</body></html>'), { code: 'PARSE_ERROR' });
  });
});

describe('google finance parser (real captured data)', () => {
  const result = expectResult(parseFinance(fixture('finance-googl.html'), { symbol: 'GOOGL:NASDAQ', nowMs: NOW }));
  const kg = defined(result.knowledge_graph, 'knowledge_graph');
  const news = defined(result.news_results, 'news_results');
  const markets = defined(result.markets, 'markets');
  const discover = defined(result.discover_more, 'discover_more');

  it('builds the summary', () => {
    assert.deepEqual(
      {
        title: result.summary.title,
        stock: result.summary.stock,
        exchange: result.summary.exchange,
        price: result.summary.price,
        extracted_price: result.summary.extracted_price,
        currency: result.summary.currency,
        date: result.summary.date,
        price_movement: result.summary.price_movement,
      },
      {
        title: 'Alphabet Inc Class A',
        stock: 'GOOGL',
        exchange: 'NASDAQ',
        price: '$344.08',
        extracted_price: 344.08,
        currency: '$',
        date: 'Sep 30, 4:00:01 PM UTC-4',
        price_movement: { percentage: 0.93, value: 3.16, movement: 'Up' },
      },
    );
    assert.equal(defined(result.summary.market, 'summary.market').trading, 'Pre-market');
  });

  it('builds the graph, knowledge graph, news, markets and discover_more', () => {
    assert.equal(result.graph.length, 30);
    assert.deepEqual(Object.keys(result.graph[0]), ['price', 'currency', 'date', 'volume']);
    assert.equal(result.graph[0].date, 'Sep 30 2026, 09:30 AM UTC-04:00');

    const stats = Object.fromEntries(kg.key_stats.stats.map((s) => [s.label, s.value]));
    assert.equal(stats['Previous close'], '$340.92');
    assert.equal(stats['Year range'], '$235.84 - $408.61');
    assert.equal(stats['Primary exchange'], 'NASDAQ');
    const info = Object.fromEntries(kg.about.info.map((i) => [i.label, i.value]));
    assert.equal(info.CEO, 'Sundar Pichai');
    assert.equal(info.Headquarters, 'Mountain View, California, United States');

    // Only the entity's own news list is used, newest first.
    assert.equal(news.length, 18);
    assert.match(news[0].title, /Why Is Google Stock Rising/);
    assert.equal(news[0].source, 'TipRanks');
    assert.equal(news[0].date, '35 minutes ago');
    assert.ok(news.every((n) => !/Tilray/.test(n.title)));

    assert.deepEqual(Object.keys(markets), ['futures', 'us', 'europe', 'asia', 'currencies', 'crypto']);
    assert.equal(markets.us[0].stock, '.DJI:INDEXDJX');
    assert.deepEqual(discover[0].items.map((i) => i.stock), ['AMZN:NASDAQ', 'MSFT:NASDAQ', 'GOOG:NASDAQ', 'NVDA:NASDAQ']);
  });

  it('returns an "empty" marker for a symbol Google does not know', () => {
    assert.deepEqual(parseFinance(fixture('finance-googl.html'), { symbol: 'NOPE:NASDAQ' }), { empty: true });
  });

  it('throws PARSE_ERROR when the page has no data blocks', () => {
    assert.throws(() => parseFinance('<html><body>layout changed</body></html>', { symbol: 'GOOGL:NASDAQ' }), { code: 'PARSE_ERROR' });
  });

  it('decodes batchexecute window payloads into a graph', () => {
    const daily = extractDataBlocks(fixture('finance-googl.html')).find((b) => JSON.stringify(b).includes('[[1],[[['));
    assert.ok(daily, 'fixture contains the daily series block');
    const inner = JSON.stringify(daily);
    const body = `)]}'\n\n${inner.length}\n${JSON.stringify([['wrb.fr', 'wnpaJ', inner, null, null, null, 'generic']])}`;
    const payloads = decodeBatchExecute(body);
    assert.equal(payloads.length, 1);
    const windowed = expectResult(parseFinance(fixture('finance-googl.html'), { symbol: 'GOOGL:NASDAQ', extras: { payloads, windowOnly: true } }));
    assert.deepEqual(Object.keys(windowed), ['summary', 'graph']);
    assert.match(windowed.graph[0].date, /^Sep 0?1 2026/);
  });

  it('tolerates truncated or malformed batchexecute bodies instead of throwing', () => {
    assert.deepEqual(decodeBatchExecute(''), []);
    assert.deepEqual(decodeBatchExecute('[[1,2'), [], 'unbalanced JSON');
    assert.deepEqual(decodeBatchExecute(`)]}'\n\n9\n[["wrb.fr","x","[1"`), [], 'truncated body');
    assert.deepEqual(decodeBatchExecute('[[1]]'), [], 'no wrb.fr rows');
    assert.deepEqual(decodeBatchExecute('[["wrb.fr","x","not json"]]'), [], 'undecodable row payload');
  });

  it('detects chart data in a payload', () => {
    const daily = extractDataBlocks(fixture('finance-googl.html')).find((b) => JSON.stringify(b).includes('[[1],[[['));
    assert.equal(containsGraph(daily), true);
    assert.equal(containsGraph([[1, 2, 3]]), false);
    assert.equal(containsGraph(null), false);
  });
});

describe('parser utilities', () => {
  it('parses prices in several formats', () => {
    assert.deepEqual(findPrice('Now $1,299.00 only'), { price: '$1,299.00', extracted_price: 1299 });
    assert.equal(defined(findPrice('1 299,50 zł')).extracted_price, 1299.5);
    assert.equal(defined(findPrice('£5')).extracted_price, 5);
    assert.equal(findPrice('no price here'), null);
    assert.equal(normalizeAmount('1.299,00'), 1299);
    assert.equal(normalizeAmount('1,299.00'), 1299);
  });

  it('unwraps Google redirect links', () => {
    assert.equal(unwrapGoogleRedirect('/url?q=https://a.example/x&sa=U'), 'https://a.example/x');
    assert.equal(unwrapGoogleRedirect('javascript:void(0)'), null);
    assert.equal(unwrapGoogleRedirect('https://a.example/y'), 'https://a.example/y');
  });
});
