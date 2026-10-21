import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type FakeUpstream, fixture, html, startFakeUpstream } from './helpers/fakeUpstream.js';
import { fakeLauncher, startApp, type TestApp } from './helpers/app.js';
import { findChrome } from './helpers/chrome.js';
import type { BrowserLauncher } from '../src/scraper/browser.js';

const webSerp = fixture('web-serp.html');

/** Fake browser that serves fixtures by URL, so toggle logic can be tested without Chrome. */
const browserFor = () =>
  fakeLauncher((url) => (new URL(url).pathname === '/search' ? webSerp : fixture('finance-googl.html')));

describe('headless mode toggle (fake browser)', () => {
  let upstream!: FakeUpstream;
  let app!: TestApp;
  afterEach(async () => {
    await app?.stop();
    await upstream?.close();
  });

  async function setup(env = {}) {
    upstream = await startFakeUpstream({
      '/search': html(webSerp),
      '/finance/quote/GOOGL:NASDAQ': html(fixture('finance-googl.html')),
    });
    const fake = browserFor();
    app = await startApp({ upstream, env, overrides: { launcher: fake.launcher } });
    return fake.state;
  }

  it('switches between HTTP and browser rendering at runtime, without a restart', async () => {
    const browser = await setup();

    const off = await app.get('/search.json?q=coffee');
    assert.equal(off.headers.get('x-scraper-mode'), 'http');
    assert.equal(off.json.search_metadata.scraper_mode, 'http');
    assert.equal(browser.launches, 0, 'HTTP mode never starts a browser');
    assert.equal(upstream.hitsFor('/search').length, 1);

    assert.equal((await app.patchSettings({ headless: true })).json.headless, true);
    const on = await app.get('/search.json?q=coffee&no_cache=true');
    assert.equal(on.headers.get('x-scraper-mode'), 'headless');
    assert.equal(on.json.search_metadata.scraper_mode, 'headless');
    assert.equal(on.json.organic_results.length, 3);
    assert.equal(browser.launches, 1);
    assert.equal(browser.renders.length, 1);
    assert.equal(upstream.hitsFor('/search').length, 1, 'the page was rendered by the browser, not fetched by the HTTP client');
    assert.equal((await app.get('/api/status')).json.browser.running, true);

    await app.patchSettings({ headless: false });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(browser.closed, 1, 'turning headless OFF releases the browser');
    assert.equal((await app.get('/api/status')).json.browser.running, false);
    const back = await app.get('/search.json?q=coffee&no_cache=true');
    assert.equal(back.headers.get('x-scraper-mode'), 'http');
    assert.equal(upstream.hitsFor('/search').length, 2);
  });

  it('reuses one browser across requests and relaunches after a toggle cycle', async () => {
    const browser = await setup();
    await app.patchSettings({ headless: true });
    await app.get('/search.json?q=a');
    await app.get('/search.json?q=b');
    assert.equal(browser.launches, 1);
    await app.patchSettings({ headless: false });
    await app.patchSettings({ headless: true });
    await new Promise((r) => setTimeout(r, 20));
    await app.get('/search.json?q=c');
    assert.equal(browser.launches, 2);
  });

  it('does not mix cached results across modes', async () => {
    const browser = await setup({ CACHE_TTL_SECONDS: '60' });
    const a = await app.get('/search.json?q=coffee');
    assert.equal(a.headers.get('x-cache'), 'MISS');
    await app.patchSettings({ headless: true });
    const b = await app.get('/search.json?q=coffee');
    assert.equal(b.headers.get('x-cache'), 'MISS');
    assert.equal(b.json.search_metadata.scraper_mode, 'headless');
    assert.equal(browser.launches, 1);
  });

  it('honours a per-request headless override over the global setting', async () => {
    const browser = await setup();
    const forced = await app.get('/search.json?q=coffee&headless=true');
    assert.equal(forced.json.search_metadata.scraper_mode, 'headless');
    assert.equal(browser.launches, 1);
    await app.patchSettings({ headless: true });
    const http = await app.get('/search.json?q=coffee&headless=false&no_cache=true');
    assert.equal(http.json.search_metadata.scraper_mode, 'http');
    assert.equal(forced.json.search_parameters.headless, undefined, 'override is not echoed in search_parameters');
  });

  it('lets an in-flight request finish in the mode it started with when the setting flips', async () => {
    upstream = await startFakeUpstream({ '/search': (req, res) => setTimeout(() => html(webSerp)(req, res), 200) });
    const fake = browserFor();
    app = await startApp({ upstream, overrides: { launcher: fake.launcher } });
    const inflight = app.get('/search.json?q=slow');
    await new Promise((r) => setTimeout(r, 60));
    await app.patchSettings({ headless: true });
    const finished = await inflight;
    assert.equal(finished.status, 200);
    assert.equal(finished.json.search_metadata.scraper_mode, 'http');
    const next = await app.get('/search.json?q=next');
    assert.equal(next.json.search_metadata.scraper_mode, 'headless');
  });

  it('JS wall: 503 in HTTP mode, or transparent fallback to the browser when enabled', async () => {
    upstream = await startFakeUpstream({ '/search': html(fixture('js-wall.html')) });
    const fake = fakeLauncher(() => webSerp);
    app = await startApp({ upstream, overrides: { launcher: fake.launcher } });

    const walled = await app.get('/search.json?q=coffee');
    assert.equal(walled.status, 503);
    assert.equal(walled.json.error_code, 'JS_REQUIRED');
    assert.equal(fake.state.launches, 0, 'fallback is opt-in');

    await app.patchSettings({ fallbackToHeadless: true });
    const recovered = await app.get('/search.json?q=coffee');
    assert.equal(recovered.status, 200);
    assert.equal(recovered.json.search_metadata.scraper_mode, 'headless');
    assert.equal(recovered.json.search_metadata.scraper_fallback, true);
    assert.equal(recovered.json.organic_results.length, 3);
    assert.equal(fake.state.launches, 1);
  });

  it('answers 503 BROWSER_UNAVAILABLE with install guidance when the browser cannot start', async () => {
    upstream = await startFakeUpstream({ '/search': html(webSerp) });
    app = await startApp({
      upstream,
      env: { HEADLESS: 'true' },
      overrides: { launcher: async () => { throw new Error('Could not find Chrome (ver. 138)'); } },
    });
    const r = await app.get('/search.json?q=coffee');
    assert.equal(r.status, 503);
    assert.equal(r.json.error_code, 'BROWSER_UNAVAILABLE');
    assert.match(r.json.error, /npm run install-browser/);
    assert.match(r.json.error, /CHROME_PATH/);
    // HTTP mode keeps working
    await app.patchSettings({ headless: false });
    assert.equal((await app.get('/search.json?q=coffee')).status, 200);
  });

  it('maps a browser navigation timeout to 504 and a CAPTCHA redirect to 429', async () => {
    upstream = await startFakeUpstream();
    const timeout = Object.assign(new Error('Navigation timeout of 30000 ms exceeded'), { name: 'TimeoutError' });
    const launcher = (async () => ({
      connected: true,
      on() {},
      close: async () => {},
      createBrowserContext: async () => ({
        close: async () => {},
        newPage: async () => ({
          setUserAgent: async () => {}, setExtraHTTPHeaders: async () => {}, setCookie: async () => {}, setRequestInterception: async () => {}, on() {},
          goto: async (url: string) => { if (url.includes('q=slow')) throw timeout; return { status: () => 429 }; },
          url: () => 'https://www.google.com/sorry/index?continue=x',
          waitForSelector: async () => {},
          content: async () => fixture('captcha.html'),
        }),
      }),
    })) as unknown as BrowserLauncher;
    app = await startApp({ upstream, env: { HEADLESS: 'true', ROBOTS_POLICY: 'off', HTTP_MAX_RETRIES: '0' }, overrides: { launcher } });
    const slow = await app.get('/search.json?q=slow');
    assert.equal(slow.status, 504);
    assert.equal(slow.json.error_code, 'UPSTREAM_TIMEOUT');
    const captcha = await app.get('/search.json?q=blocked');
    assert.equal(captcha.status, 429);
    assert.equal(captcha.json.error_code, 'UPSTREAM_BLOCKED');
  });
});

const chrome = await findChrome();
const chromePath = chrome ?? '';

describe('headless mode with a real Chrome', { skip: chrome ? false : 'no Chrome/Chromium found (set CHROME_PATH or run `npm run install-browser`)' }, () => {
  let upstream!: FakeUpstream;
  let app!: TestApp;
  afterEach(async () => {
    await app?.stop();
    await upstream?.close();
  });

  // Results exist only after JavaScript runs, exactly like Google's real SERP.
  const jsOnlyPage = () => {
    const inner = webSerp.slice(webSerp.indexOf('<body>') + 6, webSerp.indexOf('</body>'));
    return `<!DOCTYPE html><html><head><noscript><meta content="0;url=/httpservice/retry/enablejs?sei=x" http-equiv="refresh"></noscript></head><body><script>document.body.innerHTML = ${JSON.stringify(inner)};</script></body></html>`;
  };

  it('renders JavaScript-built results that HTTP mode cannot see', async () => {
    upstream = await startFakeUpstream({ '/search': html(jsOnlyPage()) });
    app = await startApp({
      upstream,
      env: { CHROME_PATH: chromePath, CHROME_NO_SANDBOX: 'true', BROWSER_READY_TIMEOUT_MS: '3000' },
    });

    const http = await app.get('/search.json?q=coffee');
    assert.equal(http.status, 503);
    assert.equal(http.json.error_code, 'JS_REQUIRED');

    await app.patchSettings({ headless: true });
    const rendered = await app.get('/search.json?q=coffee&no_cache=true');
    assert.equal(rendered.status, 200, rendered.text.slice(0, 300));
    assert.equal(rendered.json.search_metadata.scraper_mode, 'headless');
    assert.equal(rendered.json.organic_results.length, 3);
    assert.equal(rendered.json.organic_results[0].title, 'Best Coffee Grinders of 2026');
    assert.ok(rendered.json.knowledge_graph);
    assert.equal((await app.get('/api/status')).json.browser.running, true);

    await app.patchSettings({ headless: false });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await app.get('/api/status')).json.browser.running, false, 'browser is closed after switching OFF');
  });

  it('blocks image/media/font downloads and isolates cookies between requests', async () => {
    let imageRequests = 0;
    upstream = await startFakeUpstream({
      '/search': (req, res) => {
        const cookie = req.headers.cookie || '';
        res.setHeader('content-type', 'text/html');
        res.setHeader('set-cookie', 'seen=1; Path=/');
        res.end(`<html><body><div id="search"><div id="rso"><a href="https://a.example/x"><h3>${cookie.includes('seen=1') ? 'cookie leaked' : 'clean context'}</h3></a><img src="/pixel.png"></div></div></body></html>`);
      },
      '/pixel.png': (_req, res) => { imageRequests++; res.end('x'); },
    });
    app = await startApp({
      upstream,
      env: { HEADLESS: 'true', CHROME_PATH: chromePath, CHROME_NO_SANDBOX: 'true', BROWSER_READY_TIMEOUT_MS: '3000' },
    });
    const a = await app.get('/search.json?q=one');
    const b = await app.get('/search.json?q=two');
    assert.equal(a.json.organic_results[0].title, 'clean context');
    assert.equal(b.json.organic_results[0].title, 'clean context');
    assert.equal(imageRequests, 0);
  });
});
