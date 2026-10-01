import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fixture, html, startFakeUpstream, xml } from './helpers/fakeUpstream.js';
import { startApp } from './helpers/app.js';

const GOOGL = '/finance/quote/GOOGL:NASDAQ';

function standardRoutes() {
  return {
    '/search': (req, res, url) => {
      const tbm = url.searchParams.get('tbm');
      const udm = url.searchParams.get('udm');
      const page = tbm === 'nws' ? 'news-tab.html' : udm === '28' ? 'shopping.html' : tbm === 'isch' ? 'images.html' : 'web-serp.html';
      html(fixture(page))(req, res);
    },
    '/rss/search': xml(fixture('news-rss-coffee.xml')),
    '/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FtVnVHZ0pWVXlnQVAB': xml(fixture('news-rss-coffee.xml')),
    [GOOGL]: html(fixture('finance-googl.html')),
  };
}

describe('SerpApi-compatible endpoints (HTTP mode)', () => {
  let upstream;
  let app;
  beforeEach(async () => {
    upstream = await startFakeUpstream(standardRoutes());
    app = await startApp({ upstream });
  });
  afterEach(async () => {
    await app.stop();
    await upstream.close();
  });

  it('google: returns the SerpApi envelope, organic results, related searches and pagination', async () => {
    const r = await app.get('/search.json?engine=google&q=best+coffee+grinder&num=10&hl=en&gl=us&location=Austin,+Texas,+United+States&api_key=secret');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-scraper-mode'), 'http');

    const { search_metadata: m, search_parameters: p } = r.json;
    assert.equal(m.status, 'Success');
    assert.match(m.id, /^[a-f0-9]{24}$/);
    assert.equal(m.json_endpoint, `${app.base}/searches/${m.id}.json`);
    assert.equal(m.raw_html_file, `${app.base}/searches/${m.id}.html`);
    assert.match(m.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/);
    assert.equal(typeof m.total_time_taken, 'number');
    assert.equal(m.scraper_mode, 'http');
    assert.equal(m.robots_txt, 'allowed');
    assert.match(m.google_url, /\/search\?q=best\+coffee\+grinder/);

    assert.deepEqual(p, {
      engine: 'google',
      q: 'best coffee grinder',
      location: 'Austin, Texas, United States',
      google_domain: 'google.com',
      hl: 'en',
      gl: 'us',
      num: 10,
      device: 'desktop',
      location_requested: 'Austin, Texas, United States',
    });
    assert.equal(JSON.stringify(r.json).includes('secret'), false, 'api_key is never echoed');

    assert.equal(r.json.organic_results.length, 3);
    assert.equal(r.json.organic_results[0].position, 1);
    assert.ok(r.json.knowledge_graph);
    assert.ok(r.json.related_questions.length);
    assert.match(r.json.related_searches[0].serpapi_link, /\/search\.json\?engine=google&q=burr\+coffee\+grinder/);

    assert.equal(r.json.serpapi_pagination.current, 1);
    assert.match(r.json.serpapi_pagination.next, /start=10/);
    assert.deepEqual(Object.keys(r.json.serpapi_pagination.other_pages), ['2', '3', '4', '5', '6', '7', '8', '9', '10']);
    assert.match(r.json.pagination.next, /\/search\?.*start=10/);

    const hit = upstream.hitsFor('/search')[0];
    assert.equal(hit.query.q, 'best coffee grinder');
    assert.equal(hit.query.hl, 'en');
    assert.equal(hit.query.gl, 'us');
    assert.equal(hit.query.pws, '0');
    assert.match(hit.query.uule, /^w\+CAIQICI/);
    assert.match(hit.headers['user-agent'], /Chrome/);
    assert.equal(hit.headers['accept-language'].startsWith('en'), true);
  });

  it('google: passes num/start/safe/tbs through and numbers positions from start', async () => {
    const r = await app.get('/search.json?engine=google&q=coffee&num=20&start=20&safe=active&tbs=qdr:d');
    assert.equal(r.status, 200);
    const q = upstream.hitsFor('/search')[0].query;
    assert.deepEqual({ num: q.num, start: q.start, safe: q.safe, tbs: q.tbs }, { num: '20', start: '20', safe: 'active', tbs: 'qdr:d' });
    assert.equal(r.json.organic_results[0].position, 21);
    assert.equal(r.json.serpapi_pagination.current, 2);
  });

  it('google: tbm switches to the news, shopping and images tabs', async () => {
    const news = await app.get('/search.json?engine=google&q=coffee&tbm=nws');
    assert.equal(news.json.news_results.length, 2);
    assert.equal(news.json.search_parameters.tbm, 'nws');
    assert.equal(upstream.hitsFor('/search')[0].query.tbm, 'nws');

    const shop = await app.get('/search.json?engine=google&q=espresso&tbm=shop');
    assert.equal(shop.json.shopping_results.length, 2);

    const img = await app.get('/search.json?engine=google&q=coffee&tbm=isch');
    assert.equal(img.json.images_results.length, 2);

    const bad = await app.get('/search.json?engine=google&q=coffee&tbm=vid');
    assert.equal(bad.status, 400);
  });

  it('google_news: reads the RSS feed in HTTP mode and maps locale parameters', async () => {
    const r = await app.get('/search.json?engine=google_news&q=coffee&gl=us&hl=en');
    assert.equal(r.status, 200);
    assert.equal(r.json.news_results.length, 6);
    assert.equal(r.json.news_results[0].source.name, 'Forbes');
    assert.deepEqual(r.json.search_parameters, { engine: 'google_news', q: 'coffee', gl: 'us', hl: 'en', device: 'desktop' });
    const q = upstream.hitsFor('/rss/search')[0].query;
    assert.deepEqual({ q: q.q, hl: q.hl, gl: q.gl, ceid: q.ceid }, { q: 'coffee', hl: 'en-US', gl: 'US', ceid: 'US:en' });
    assert.equal(r.json.search_metadata.google_url.includes('/rss/'), false, 'google_url points at the human page');
  });

  it('google_news: num truncates, topic_token uses the topics feed, story_token needs a browser', async () => {
    const few = await app.get('/search.json?engine=google_news&q=coffee&num=2');
    assert.equal(few.json.news_results.length, 2);

    const topic = await app.get('/search.json?engine=google_news&topic_token=CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FtVnVHZ0pWVXlnQVAB');
    assert.equal(topic.status, 200);
    assert.equal(upstream.hitsFor('/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FtVnVHZ0pWVXlnQVAB').length, 1);

    const story = await app.get('/search.json?engine=google_news&story_token=CAAqNggKIjBDQklTSGpvSmMzUnZjbmt0TXpZd1NoRUtEd2lVLXRYMURSRlZkQmlSYk5hTElpZ0FQAQ');
    assert.equal(story.status, 503);
    assert.equal(story.json.error_code, 'JS_REQUIRED');

    assert.equal((await app.get('/search.json?engine=google_news')).status, 400);
  });

  it('google_shopping and google_images accept their own engine names', async () => {
    const shop = await app.get('/search.json?engine=google_shopping&q=espresso+machine&num=1');
    assert.equal(shop.status, 200);
    assert.equal(shop.json.search_parameters.engine, 'google_shopping');
    assert.equal(shop.json.shopping_results.length, 1);
    assert.equal(shop.json.shopping_results[0].extracted_price, 599.95);
    assert.equal(upstream.hitsFor('/search')[0].query.udm, '28');

    const img = await app.get('/search.json?engine=google_images&q=coffee&ijn=1');
    assert.equal(img.status, 200);
    assert.equal(img.json.images_results[0].position, 101);
    assert.equal(img.json.images_results[0].original, 'https://cdn.example.com/beans.jpg');
    assert.equal(img.json.search_information.query_displayed, 'coffee');
    assert.match(img.json.serpapi_pagination.next, /ijn=2/);
    assert.equal(img.json.suggested_searches[0].name, 'Cup');
    assert.match(img.json.suggested_searches[0].serpapi_link, /engine=google_images&.*q=coffee\+cup/);
  });

  it('google_finance: returns summary, graph, knowledge graph, news, markets', async () => {
    const r = await app.get('/search.json?engine=google_finance&q=GOOGL:NASDAQ&hl=en');
    assert.equal(r.status, 200);
    assert.equal(r.json.summary.price, '$344.08');
    assert.equal(r.json.summary.price_movement.movement, 'Up');
    assert.ok(r.json.graph.length > 0);
    assert.ok(r.json.knowledge_graph.key_stats.stats.length > 0);
    assert.ok(r.json.news_results.length > 0);
    assert.ok(r.json.markets.us.length > 0);
    assert.deepEqual(r.json.search_parameters, { engine: 'google_finance', q: 'GOOGL:NASDAQ', hl: 'en', device: 'desktop' });
    assert.equal(upstream.hitsFor(GOOGL)[0].query.hl, 'en');
  });

  it('google_finance: validates q, handles unknown symbols and non-default windows', async () => {
    assert.equal((await app.get('/search.json?engine=google_finance')).status, 400);
    const badSymbol = await app.get('/search.json?engine=google_finance&q=../../etc/passwd');
    assert.equal(badSymbol.status, 400);
    assert.match(badSymbol.json.error, /TICKER:EXCHANGE/);

    upstream.set('/finance/quote/NOPE:NASDAQ', html(fixture('finance-googl.html')));
    const unknown = await app.get('/search.json?engine=google_finance&q=NOPE:NASDAQ');
    assert.equal(unknown.status, 200);
    assert.equal(unknown.json.error, "Google Finance hasn't returned any results for this query.");

    const win = await app.get('/search.json?engine=google_finance&q=GOOGL:NASDAQ&window=1Y');
    assert.equal(win.status, 503);
    assert.equal(win.json.error_code, 'JS_REQUIRED');
    assert.equal((await app.get('/search.json?engine=google_finance&q=GOOGL:NASDAQ&window=2Y')).status, 400);
  });

  it('serves raw HTML via output=html and /search.html, and archives recent searches', async () => {
    const json = await app.get('/search.json?engine=google&q=coffee');
    const id = json.json.search_metadata.id;

    const raw = await app.get('/search.json?engine=google&q=coffee&output=html&no_cache=true');
    assert.match(raw.headers.get('content-type'), /text\/html/);
    assert.match(raw.text, /id="rso"/);
    assert.equal((await app.get('/search.html?engine=google&q=coffee')).text.includes('id="rso"'), true);

    const archived = await app.get(`/searches/${id}.json`);
    assert.deepEqual(archived.json, json.json);
    assert.match((await app.get(`/searches/${id}.html`)).text, /id="rso"/);
    assert.equal((await app.get('/searches/000000000000000000000000.json')).status, 404);

    const rss = await app.get('/search.html?engine=google_news&q=coffee');
    assert.match(rss.headers.get('content-type'), /application\/xml/);
  });

  it('answers unknown routes with a JSON 404', async () => {
    const r = await app.get('/nope');
    assert.equal(r.status, 404);
    assert.equal(r.json.error_code, 'NOT_FOUND');
  });
});

describe('request validation', () => {
  let upstream;
  let app;
  beforeEach(async () => {
    upstream = await startFakeUpstream(standardRoutes());
    app = await startApp({ upstream });
  });
  afterEach(async () => {
    await app.stop();
    await upstream.close();
  });

  const cases = [
    ['missing q', '/search.json?engine=google', /Missing query `q`/],
    ['empty q', '/search.json?engine=google&q=', /Missing query `q`/],
    ['unsupported engine', '/search.json?engine=bing&q=x', /Unsupported `bing` search engine/],
    ['num too large', '/search.json?q=x&num=101', /`num` must be an integer between 1 and 100/],
    ['num not a number', '/search.json?q=x&num=ten', /`num`/],
    ['negative start', '/search.json?q=x&start=-1', /`start`/],
    ['bad hl', '/search.json?q=x&hl=english-us!', /Invalid `hl`/],
    ['bad gl', '/search.json?q=x&gl=usa', /Invalid `gl`/],
    ['non-google domain (SSRF guard)', '/search.json?q=x&google_domain=evil.example.com', /google_domain/],
    ['mobile device', '/search.json?q=x&device=mobile', /desktop/],
    ['bad safe', '/search.json?q=x&safe=maybe', /`safe`/],
    ['bad no_cache', '/search.json?q=x&no_cache=perhaps', /`no_cache`/],
    ['bad output', '/search.json?q=x&output=xml', /`output`/],
    ['overlong q', `/search.json?q=${'a'.repeat(1001)}`, /too long/],
  ];
  for (const [name, url, message] of cases) {
    it(`400: ${name}`, async () => {
      const r = await app.get(url);
      assert.equal(r.status, 400);
      assert.equal(r.json.error_code, 'INVALID_PARAMETER');
      assert.match(r.json.error, message);
    });
  }

  it('never contacts the upstream for an invalid request', async () => {
    await app.get('/search.json?q=x&num=999');
    assert.equal(upstream.hits.length, 0);
  });

  it('accepts a custom google_domain from the allow-list pattern', async () => {
    const r = await app.get('/search.json?q=x&google_domain=google.co.uk');
    assert.equal(r.status, 200);
    assert.equal(r.json.search_parameters.google_domain, 'google.co.uk');
  });
});

describe('error handling: network, upstream and parsing failures', () => {
  let upstream;
  let app;
  afterEach(async () => {
    await app?.stop();
    await upstream?.close();
  });

  it('retries transient 5xx responses and succeeds', async () => {
    let calls = 0;
    upstream = await startFakeUpstream({
      '/search': (req, res) => {
        calls++;
        if (calls === 1) {
          res.statusCode = 503;
          return res.end('try later');
        }
        return html(fixture('web-serp.html'))(req, res);
      },
    });
    app = await startApp({ upstream });
    const r = await app.get('/search.json?q=coffee');
    assert.equal(r.status, 200);
    assert.equal(calls, 2);
  });

  it('gives up after the configured retries with 502 UPSTREAM_HTTP_ERROR', async () => {
    upstream = await startFakeUpstream({ '/search': (req, res) => { res.statusCode = 500; res.end('boom'); } });
    app = await startApp({ upstream, env: { HTTP_MAX_RETRIES: '2' } });
    const r = await app.get('/search.json?q=coffee');
    assert.equal(r.status, 502);
    assert.equal(r.json.error_code, 'UPSTREAM_HTTP_ERROR');
    assert.equal(upstream.hitsFor('/search').length, 3);
  });

  it('does not retry client errors', async () => {
    upstream = await startFakeUpstream({ '/search': (req, res) => { res.statusCode = 403; res.end('no'); } });
    app = await startApp({ upstream });
    const r = await app.get('/search.json?q=coffee');
    assert.equal(r.status, 502);
    assert.match(r.json.error, /HTTP 403/);
    assert.equal(upstream.hitsFor('/search').length, 1);
  });

  it('maps a refused connection to 502 UPSTREAM_NETWORK_ERROR', async () => {
    upstream = await startFakeUpstream();
    const dead = { url: upstream.url };
    app = await startApp({ upstream: dead, env: { ROBOTS_POLICY: 'off', HTTP_MAX_RETRIES: '1' } });
    await upstream.close();
    const r = await app.get('/search.json?q=coffee');
    assert.equal(r.status, 502);
    assert.equal(r.json.error_code, 'UPSTREAM_NETWORK_ERROR');
    assert.match(r.json.error, /ECONNREFUSED/);
    upstream = undefined;
  });

  it('maps a stalled upstream to 504 UPSTREAM_TIMEOUT', async () => {
    upstream = await startFakeUpstream({ '/search': () => {} });
    app = await startApp({ upstream, env: { HTTP_TIMEOUT_MS: '250', HTTP_MAX_RETRIES: '0' } });
    const r = await app.get('/search.json?q=coffee');
    assert.equal(r.status, 504);
    assert.equal(r.json.error_code, 'UPSTREAM_TIMEOUT');
  });

  it('maps an unparseable results page to 502 PARSE_ERROR (and never caches it)', async () => {
    upstream = await startFakeUpstream({ '/search': html('<html><body><p>Totally different layout</p></body></html>') });
    app = await startApp({ upstream, env: { CACHE_TTL_SECONDS: '60' } });
    const r = await app.get('/search.json?q=coffee');
    assert.equal(r.status, 502);
    assert.equal(r.json.error_code, 'PARSE_ERROR');
    assert.equal((await app.get('/search.json?q=coffee')).status, 502);
    assert.equal(upstream.hitsFor('/search').length, 2);
  });

  it('maps a malformed RSS feed to PARSE_ERROR', async () => {
    upstream = await startFakeUpstream({ '/rss/search': xml('<html>not a feed</html>') });
    app = await startApp({ upstream });
    const r = await app.get('/search.json?engine=google_news&q=coffee');
    assert.equal(r.status, 502);
    assert.equal(r.json.error_code, 'PARSE_ERROR');
  });

  it('reports an empty results page as HTTP 200 with SerpApi-style `error`', async () => {
    upstream = await startFakeUpstream({ '/search': html(fixture('web-serp-empty.html')) });
    app = await startApp({ upstream });
    const r = await app.get('/search.json?q=zzzxqv');
    assert.equal(r.status, 200);
    assert.equal(r.json.error, "Google hasn't returned any results for this query.");
    assert.equal(r.json.search_metadata.status, 'Success');
    assert.equal(r.json.organic_results, undefined);
  });

  it('detects a CAPTCHA, answers 429 with Retry-After, and pauses the host without re-hitting it', async () => {
    upstream = await startFakeUpstream({ '/search': (req, res) => { res.statusCode = 429; res.setHeader('content-type', 'text/html'); res.end(fixture('captcha.html')); } });
    app = await startApp({ upstream });
    const first = await app.get('/search.json?q=coffee');
    assert.equal(first.status, 429);
    assert.equal(first.json.error_code, 'UPSTREAM_BLOCKED');
    assert.match(first.json.error, /CAPTCHA/);

    const second = await app.get('/search.json?q=tea');
    assert.equal(second.status, 429);
    assert.ok(Number(second.headers.get('retry-after')) >= 1);
    assert.equal(upstream.hitsFor('/search').length, 1, 'cooldown prevents further upstream requests');
  });

  it('answers 503 JS_REQUIRED when Google serves its JS wall to the HTTP client', async () => {
    upstream = await startFakeUpstream({ '/search': html(fixture('js-wall.html')) });
    app = await startApp({ upstream });
    const r = await app.get('/search.json?q=coffee');
    assert.equal(r.status, 503);
    assert.equal(r.json.error_code, 'JS_REQUIRED');
    assert.match(r.json.error, /headless/i);
  });

  it('recovers from a failure: the next request works', async () => {
    let fail = true;
    upstream = await startFakeUpstream({ '/search': (req, res) => (fail ? (res.statusCode = 400, res.end('x')) : html(fixture('web-serp.html'))(req, res)) });
    app = await startApp({ upstream });
    assert.equal((await app.get('/search.json?q=coffee')).status, 502);
    fail = false;
    assert.equal((await app.get('/search.json?q=coffee')).status, 200);
  });
});

describe('robots.txt policy', () => {
  let upstream;
  let app;
  beforeEach(async () => {
    upstream = await startFakeUpstream({
      ...standardRoutes(),
      '/robots.txt': (req, res) => res.end('User-agent: *\nDisallow: /search\nDisallow: /rss\n'),
    });
    app = await startApp({ upstream });
  });
  afterEach(async () => {
    await app.stop();
    await upstream.close();
  });

  it('enforce (default): refuses disallowed URLs without fetching them, allows the rest', async () => {
    const blocked = await app.get('/search.json?q=coffee');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.error_code, 'ROBOTS_DISALLOWED');
    assert.equal(upstream.hitsFor('/search').length, 0);
    assert.equal((await app.get('/search.json?engine=google_news&q=coffee')).status, 403);

    const allowed = await app.get('/search.json?engine=google_finance&q=GOOGL:NASDAQ');
    assert.equal(allowed.status, 200);
    assert.equal(allowed.json.search_metadata.robots_txt, 'allowed');
  });

  it('warn: proceeds but records the violation; off: does not even fetch robots.txt', async () => {
    assert.equal((await app.patchSettings({ robotsPolicy: 'warn' })).status, 200);
    const warned = await app.get('/search.json?q=coffee');
    assert.equal(warned.status, 200);
    assert.equal(warned.json.search_metadata.robots_txt, 'disallowed');

    app.components.robots.clear();
    upstream.hits.length = 0;
    await app.patchSettings({ robotsPolicy: 'off' });
    const off = await app.get('/search.json?q=coffee&no_cache=true');
    assert.equal(off.status, 200);
    assert.equal(off.json.search_metadata.robots_txt, 'skipped');
    assert.equal(upstream.hitsFor('/robots.txt').length, 0);
  });

  it('enforce: refuses to scrape when robots.txt cannot be read (5xx), and allows when it is absent (404)', async () => {
    upstream.set('/robots.txt', (req, res) => { res.statusCode = 500; res.end('err'); });
    const unavailable = await app.get('/search.json?engine=google_finance&q=GOOGL:NASDAQ');
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.json.error_code, 'ROBOTS_UNAVAILABLE');

    app.components.robots.clear();
    upstream.set('/robots.txt', (req, res) => { res.statusCode = 404; res.end('none'); });
    assert.equal((await app.get('/search.json?q=coffee')).status, 200);
  });
});

describe('caching and rate limiting', () => {
  let upstream;
  let app;
  afterEach(async () => {
    await app?.stop();
    await upstream?.close();
  });

  it('serves identical searches from cache until no_cache or a mode change', async () => {
    upstream = await startFakeUpstream(standardRoutes());
    app = await startApp({ upstream, env: { CACHE_TTL_SECONDS: '60' } });
    const a = await app.get('/search.json?q=coffee');
    const b = await app.get('/search.json?q=coffee');
    assert.equal(a.headers.get('x-cache'), 'MISS');
    assert.equal(b.headers.get('x-cache'), 'HIT');
    assert.equal(b.json.search_metadata.id, a.json.search_metadata.id);
    assert.equal(upstream.hitsFor('/search').length, 1);

    assert.equal((await app.get('/search.json?q=coffee&no_cache=true')).headers.get('x-cache'), 'MISS');
    assert.equal(upstream.hitsFor('/search').length, 2);

    await app.patchSettings({ cacheTtlSeconds: 0 });
    assert.equal((await app.get('/search.json?q=coffee')).headers.get('x-cache'), 'MISS');
  });

  it('spaces upstream requests by the configured minimum interval', async () => {
    upstream = await startFakeUpstream(standardRoutes());
    app = await startApp({ upstream, env: { RATE_MIN_INTERVAL_MS: '150' } });
    const t0 = Date.now();
    await Promise.all(['a', 'b', 'c'].map((q) => app.get(`/search.json?q=${q}`)));
    assert.ok(Date.now() - t0 >= 290, `3 requests took ${Date.now() - t0}ms`);
    const times = upstream.hitsFor('/search').length;
    assert.equal(times, 3);
  });

  it('the interval can be changed at runtime without a restart', async () => {
    upstream = await startFakeUpstream(standardRoutes());
    app = await startApp({ upstream, env: { RATE_MIN_INTERVAL_MS: '400' } });
    await app.get('/search.json?q=a');
    await app.patchSettings({ minIntervalMs: 0 });
    const t0 = Date.now();
    await app.get('/search.json?q=b');
    await app.get('/search.json?q=c');
    await app.get('/search.json?q=d');
    assert.ok(Date.now() - t0 < 900, `took ${Date.now() - t0}ms`);
  });

  it('rejects with 429 + Retry-After when too many searches are queued', async () => {
    upstream = await startFakeUpstream({ '/search': (req, res) => setTimeout(() => html(fixture('web-serp.html'))(req, res), 150) });
    app = await startApp({ upstream, env: { RATE_MAX_QUEUE: '1' } });
    const results = await Promise.all(['a', 'b', 'c', 'd'].map((q) => app.get(`/search.json?q=${q}`)));
    const statuses = results.map((r) => r.status).sort();
    assert.ok(statuses.includes(429), `statuses: ${statuses}`);
    assert.ok(statuses.includes(200));
    const limited = results.find((r) => r.status === 429);
    assert.equal(limited.json.error_code, 'RATE_LIMITED');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  });
});

describe('admin API, status and safety', () => {
  let upstream;
  let app;
  beforeEach(async () => {
    upstream = await startFakeUpstream(standardRoutes());
    app = await startApp({ upstream });
  });
  afterEach(async () => {
    await app.stop();
    await upstream.close();
  });

  it('GET/PATCH/DELETE /api/settings', async () => {
    const initial = await app.get('/api/settings');
    assert.deepEqual(initial.json, { headless: false, fallbackToHeadless: false, robotsPolicy: 'enforce', minIntervalMs: 0, cacheTtlSeconds: 0 });
    const patched = await app.patchSettings({ headless: true, fallbackToHeadless: true });
    assert.equal(patched.json.headless, true);
    assert.equal((await app.get('/api/status')).json.mode, 'headless');
    const reset = await fetch(`${app.base}/api/settings`, { method: 'DELETE' });
    assert.equal((await reset.json()).headless, false);
  });

  it('rejects invalid settings changes with 400 and leaves state untouched', async () => {
    for (const bad of [{ headless: 'maybe' }, { robotsPolicy: 'nope' }, { unknown: 1 }, { minIntervalMs: -5 }]) {
      const r = await app.patchSettings(bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    const malformed = await fetch(`${app.base}/api/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{oops' });
    assert.equal(malformed.status, 400);
    const wrongType = await fetch(`${app.base}/api/settings`, { method: 'PATCH', headers: { 'content-type': 'text/plain' }, body: '{"headless":true}' });
    assert.equal(wrongType.status, 400, 'non-JSON content types (cross-site simple requests) are refused');
    assert.equal((await app.get('/api/settings')).json.headless, false);
  });

  it('records recent searches in /api/history, including failures', async () => {
    await app.get('/search.json?q=coffee');
    await app.get('/search.json?engine=google_finance&q=GOOGL:NASDAQ&window=1Y');
    const { history } = (await app.get('/api/history')).json;
    assert.equal(history.length, 2);
    assert.deepEqual(
      { engine: history[0].engine, ok: history[0].ok, code: history[0].code, status: history[0].status },
      { engine: 'google_finance', ok: false, code: 'JS_REQUIRED', status: 503 },
    );
    assert.equal(history[1].ok, true);
    assert.equal(history[1].mode, 'http');
  });

  it('serves the web UI and a health check', async () => {
    assert.equal((await app.get('/health')).json.status, 'ok');
    const index = await app.get('/');
    assert.equal(index.status, 200);
    assert.match(index.text, /SERP Alter Ego/);
  });

  it('refuses non-loopback Host headers when bound to loopback (DNS-rebinding guard)', async () => {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(`${app.base}/api/settings`, { headers: { Host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  });
});
