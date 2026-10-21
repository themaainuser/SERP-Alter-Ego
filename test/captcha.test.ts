import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type FakeUpstream, fixture, html, startFakeUpstream } from './helpers/fakeUpstream.js';
import { startApp, type TestApp } from './helpers/app.js';
import { findChrome, NO_CHROME_MESSAGE } from './helpers/chrome.js';
import type { BrowserLauncher } from '../src/scraper/browser.js';

const webSerp = fixture('web-serp.html');
const captcha = fixture('captcha.html');

const SORRY = 'https://www.google.com/sorry/index?continue=https%3A%2F%2Fwww.google.com%2Fsearch%3Fq%3Dblocked';
const RESULTS = 'https://www.google.com/search?q=blocked';

/**
 * Fake browser that lands on Google's /sorry/ CAPTCHA and — after `solveAfterMs`
 * (null = never) — redirects to the results page, standing in for a human solving it
 * by hand in the open window. The clock starts at navigation, like Google's redirect.
 */
function captchaLauncher(solveAfterMs: number | null): BrowserLauncher {
  const state = { launchedAt: 0 };
  const onSorry = () => solveAfterMs === null || Date.now() - state.launchedAt < solveAfterMs;
  const page = async () => ({
    setUserAgent: async () => {},
    setExtraHTTPHeaders: async () => {},
    setCookie: async () => {},
    setRequestInterception: async () => {},
    on() {},
    off() {},
    goto: async () => {
      state.launchedAt = Date.now();
      return { status: () => 429 };
    },
    url: () => (onSorry() ? SORRY : RESULTS),
    waitForSelector: async () => {},
    waitForNetworkIdle: async () => {},
    content: async () => (onSorry() ? captcha : webSerp),
    evaluate: async () => true,
    close: async () => {},
  });
  const context = async () => ({ newPage: page, close: async () => {} });
  return (async () => ({
    get connected() {
      return true;
    },
    on() {},
    process: () => null,
    createBrowserContext: context,
    defaultBrowserContext: context,
    close: async () => {},
  })) as unknown as BrowserLauncher;
}

/**
 * Fake that stays on /sorry/ until `clearOnGoto` navigations have happened (null = never clears),
 * counting every goto so a test can assert exactly how many automatic retries ran. Like Google,
 * each navigation restarts the challenge, so a failed attempt never accidentally "solves" it.
 */
function retryLauncher({ clearOnGoto }: { clearOnGoto: number | null }) {
  const state = { gotos: 0 };
  const cleared = () => clearOnGoto !== null && state.gotos >= clearOnGoto;
  const page = async () => ({
    setUserAgent: async () => {},
    setExtraHTTPHeaders: async () => {},
    setCookie: async () => {},
    setRequestInterception: async () => {},
    on() {},
    off() {},
    goto: async () => {
      state.gotos += 1;
      return { status: () => (cleared() ? 200 : 429) };
    },
    url: () => (cleared() ? RESULTS : SORRY),
    waitForSelector: async () => {},
    waitForNetworkIdle: async () => {},
    content: async () => (cleared() ? webSerp : captcha),
    evaluate: async () => true,
    close: async () => {},
  });
  const context = async () => ({ newPage: page, close: async () => {} });
  const launcher = (async () => ({
    get connected() {
      return true;
    },
    on() {},
    process: () => null,
    createBrowserContext: context,
    defaultBrowserContext: context,
    close: async () => {},
  })) as unknown as BrowserLauncher;
  return { launcher, gotos: () => state.gotos };
}

describe('interactive CAPTCHA handling (fake browser)', () => {
  let upstream!: FakeUpstream;
  let app!: TestApp;
  afterEach(async () => {
    await app?.stop();
    await upstream?.close();
  });

  const env = (over: Record<string, string> = {}) => ({
    HEADLESS: 'true',
    BROWSER_HEADFUL: 'true',
    BROWSER_CAPTCHA_INTERACTIVE: 'true',
    BROWSER_CAPTCHA_WAIT_MS: '1500',
    ...over,
  });

  async function setup(solveAfterMs: number | null, over: Record<string, string> = {}) {
    upstream = await startFakeUpstream({ '/search': html(webSerp) });
    app = await startApp({ upstream, env: env(over), overrides: { launcher: captchaLauncher(solveAfterMs) } });
  }

  it('holds the CAPTCHA page open for the human solve, then returns the real results', async () => {
    await setup(600);
    const started = Date.now();
    const r = await app.get('/search.json?q=blocked');
    const ms = Date.now() - started;

    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.equal(r.json.organic_results.length, 3);
    assert.equal(r.json.search_metadata.scraper_mode, 'headless');
    assert.ok(ms >= 600, `render should have waited for the solve, took ${ms}ms`);
  });

  it('gives up after BROWSER_CAPTCHA_WAIT_MS and reports the block as before', async () => {
    await setup(null);
    const r = await app.get('/search.json?q=blocked');
    assert.equal(r.status, 429);
    assert.equal(r.json.error_code, 'UPSTREAM_BLOCKED');
  });

  it('does not wait for a solve when the browser is headless (nobody can see it)', async () => {
    await setup(600, { BROWSER_HEADFUL: 'false' });
    const r = await app.get('/search.json?q=blocked');
    // If it had waited, the fake would have "solved" by then and this would be 200.
    assert.equal(r.status, 429);
    assert.equal(r.json.error_code, 'UPSTREAM_BLOCKED');
  });

  it('does not wait when BROWSER_CAPTCHA_INTERACTIVE=false', async () => {
    await setup(600, { BROWSER_CAPTCHA_INTERACTIVE: 'false' });
    const r = await app.get('/search.json?q=blocked');
    assert.equal(r.status, 429);
    assert.equal(r.json.error_code, 'UPSTREAM_BLOCKED');
  });

  it('auto-retries the CAPTCHA itself up to 3 times, then asks the human to take over', async () => {
    const retry = retryLauncher({ clearOnGoto: null }); // never clears on its own
    upstream = await startFakeUpstream({ '/search': html(webSerp) });
    app = await startApp({
      upstream,
      env: env({ BROWSER_CAPTCHA_WAIT_MS: '800' }),
      overrides: { launcher: retry.launcher },
    });
    const r = await app.get('/search.json?q=blocked');

    assert.equal(r.status, 429, r.text.slice(0, 300));
    assert.equal(r.json.error_code, 'UPSTREAM_BLOCKED');
    assert.equal(
      retry.gotos(),
      4,
      '1 initial navigation + exactly 3 automatic retries before the manual escalation',
    );
  });

  it('stops auto-retrying the moment an automatic clear succeeds (no human needed)', async () => {
    const retry = retryLauncher({ clearOnGoto: 2 }); // clears on the FIRST automatic retry
    upstream = await startFakeUpstream({ '/search': html(webSerp) });
    app = await startApp({ upstream, env: env(), overrides: { launcher: retry.launcher } });
    const r = await app.get('/search.json?q=blocked');

    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.equal(r.json.organic_results.length, 3);
    assert.equal(retry.gotos(), 2, 'initial navigation + one automatic retry, then it stopped');
  });
});

const chrome = await findChrome();

describe('interactive CAPTCHA with a real Chrome', { skip: chrome ? false : NO_CHROME_MESSAGE }, () => {
  let upstream!: FakeUpstream;
  let app!: TestApp;
  afterEach(async () => {
    await app?.stop();
    await upstream?.close();
  });

  it('follows the real redirect off /sorry/ and waits for results that hydrate over the network', async () => {
    // /search answers with a CAPTCHA redirect exactly once, like Google; the /sorry/ page
    // then bounces back (standing in for the hand-solve). The second hit serves an EMPTY
    // SERP shell — results arrive later over fetch(), as Google's client-side hydration
    // does after an interstitial — so an eager capture would return zero results.
    const results = [
      { link: 'https://www.example.com/grinders', title: 'Best Coffee Grinders of 2026' },
      { link: 'https://www.example.com/burr', title: 'Burr vs Blade Grinders' },
      { link: 'https://www.example.com/espresso', title: 'Espresso Grinder Guide' },
    ];
    let searchHits = 0;
    upstream = await startFakeUpstream({
      '/search': (req, res) => {
        if (++searchHits === 1) {
          res.writeHead(302, { location: '/sorry/index?continue=%2Fsearch%3Fq%3Dblocked' });
          return void res.end();
        }
        html(
          `<!DOCTYPE html><html><head><title>blocked - Google Search</title></head><body>` +
            `<div id="search"><div id="rso"></div></div>` +
            `<script>fetch('/results.json?delay=1500').then((r) => r.json()).then((items) => {` +
            `document.getElementById('rso').innerHTML = items.map((i) =>` +
            `'<div class="MjjYud"><div class="g"><div class="tF2Cxc"><div class="yuRUBC"><a href="' + i.link + '"><h3>' + i.title + '</h3></a></div></div></div></div>'` +
            `).join('');});</script></body></html>`,
        )(req, res);
      },
      '/sorry/index': html(
        `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=/search?q=blocked">` +
          `<title>https://www.google.com/sorry/index</title></head><body>` +
          `<form id="captcha-form" action="index"></form>Our systems have detected unusual traffic from your computer network.` +
          `</body></html>`,
      ),
      '/results.json': (_req, res, url) => {
        const delay = Number(url.searchParams.get('delay') ?? '0');
        setTimeout(() => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(results));
        }, delay);
      },
    });
    app = await startApp({
      upstream,
      env: {
        HEADLESS: 'true',
        BROWSER_HEADFUL: 'true', // the feature only engages with a window a human can use
        BROWSER_CAPTCHA_WAIT_MS: '8000',
        BROWSER_READY_TIMEOUT_MS: '3000',
        BROWSER_NAV_TIMEOUT_MS: '10000',
        CHROME_PATH: chrome ?? '',
        CHROME_NO_SANDBOX: 'true',
      },
    });

    const started = Date.now();
    const r = await app.get('/search.json?q=blocked');
    const ms = Date.now() - started;

    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.equal(r.json.organic_results.length, 3, 'results must be captured AFTER the delayed hydration, not from the empty shell');
    assert.equal(r.json.organic_results[0].title, 'Best Coffee Grinders of 2026');
    assert.ok(searchHits >= 2, 'the /sorry/ page was followed by a second request for the results');
    assert.ok(ms >= 1500, `render must have waited for the hydration fetch, took ${ms}ms`);
  });
});
