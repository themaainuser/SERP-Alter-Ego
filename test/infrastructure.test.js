import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture } from './helpers/fakeUpstream.js';
import { classifyPage, looksLikeCaptcha, looksLikeConsent, looksLikeJsWall } from '../src/scraper/guards.js';
import { RateLimiter } from '../src/scraper/rateLimiter.js';
import { RobotsChecker } from '../src/scraper/robots.js';
import { SettingsStore } from '../src/settings.js';
import { TtlCache } from '../src/scraper/cache.js';
import { HttpFetcher } from '../src/scraper/httpFetcher.js';
import { loadConfig } from '../src/config.js';
import { redactUrl } from '../src/logger.js';
import { encodeUule } from '../src/serpapi/params.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('page guards', () => {
  it('recognises the JS wall served to script-less clients', () => {
    assert.equal(looksLikeJsWall(fixture('js-wall.html')), true);
    assert.equal(classifyPage({ html: fixture('js-wall.html'), url: 'https://www.google.com/search', status: 200 }, { mode: 'http', host: 'www.google.com' }).code, 'JS_REQUIRED');
  });

  it('does not mistake a rendered SERP (which also contains the <noscript> block) for a JS wall', () => {
    const rendered = fixture('web-serp.html').replace('<body>', `<body><noscript><meta content="0;url=/httpservice/retry/enablejs" http-equiv="refresh"></noscript>`);
    assert.equal(looksLikeJsWall(rendered), false);
  });

  it('ignores the JS wall check in headless mode', () => {
    assert.equal(classifyPage({ html: fixture('js-wall.html'), url: 'x', status: 200 }, { mode: 'headless', host: 'h' }), null);
  });

  it('recognises CAPTCHA pages by URL, status and markup', () => {
    assert.equal(looksLikeCaptcha(fixture('captcha.html')), true);
    assert.equal(looksLikeCaptcha('<html></html>', 'https://www.google.com/sorry/index?continue=x'), true);
    assert.equal(classifyPage({ html: '', url: 'x', status: 429 }, { mode: 'http', host: 'h' }).code, 'UPSTREAM_BLOCKED');
    assert.equal(looksLikeCaptcha(fixture('web-serp.html')), false);
  });

  it('recognises the consent interstitial', () => {
    assert.equal(looksLikeConsent('<html></html>', 'https://consent.google.com/m?continue=x'), true);
    assert.equal(looksLikeConsent('<form action="https://consent.google.com/save">', 'https://www.google.com/'), true);
    assert.equal(looksLikeConsent(fixture('web-serp.html'), 'https://www.google.com/search'), false);
  });
});

describe('rate limiter', () => {
  const make = (opts = {}) => new RateLimiter({ getMinIntervalMs: () => 60, jitterMs: 0, ...opts });

  it('spaces requests to the same host by the minimum interval', async () => {
    const limiter = make();
    const starts = [];
    await Promise.all([1, 2, 3].map(() => limiter.run('a', async () => starts.push(Date.now()))));
    assert.ok(starts[1] - starts[0] >= 55, `gap 1 was ${starts[1] - starts[0]}ms`);
    assert.ok(starts[2] - starts[1] >= 55, `gap 2 was ${starts[2] - starts[1]}ms`);
  });

  it('does not delay different hosts against each other', async () => {
    const limiter = make({ getMinIntervalMs: () => 200 });
    const t0 = Date.now();
    await Promise.all([limiter.run('a', async () => {}), limiter.run('b', async () => {})]);
    assert.ok(Date.now() - t0 < 100);
  });

  it('applies a changed interval to later requests (runtime setting)', async () => {
    let interval = 150;
    const limiter = make({ getMinIntervalMs: () => interval });
    await limiter.run('a', async () => {});
    interval = 0;
    await sleep(5);
    const t0 = Date.now();
    // the gap computed at the first start (150ms) still applies once; the next gap uses 0
    await limiter.run('a', async () => {});
    await limiter.run('a', async () => {});
    assert.ok(Date.now() - t0 < 400);
  });

  it('limits concurrency', async () => {
    const limiter = make({ getMinIntervalMs: () => 0, concurrency: 2 });
    let running = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 6 }, () => limiter.run('a', async () => {
      running++;
      peak = Math.max(peak, running);
      await sleep(15);
      running--;
    })));
    assert.equal(peak, 2);
  });

  it('rejects with RATE_LIMITED when the queue is full', async () => {
    const limiter = make({ getMinIntervalMs: () => 0, maxQueue: 1 });
    const slow = limiter.run('a', () => sleep(50));
    const queued = limiter.run('a', async () => 'ok');
    await assert.rejects(limiter.run('a', async () => 'x'), { code: 'RATE_LIMITED', status: 429 });
    await Promise.all([slow, queued]);
  });

  it('pauses a blocked host and fails fast with Retry-After, then recovers', async () => {
    const limiter = make({ getMinIntervalMs: () => 0 });
    limiter.block('a', 80, 'captcha');
    await assert.rejects(limiter.run('a', async () => 'x'), (e) => e.code === 'UPSTREAM_BLOCKED' && e.retryAfter >= 1);
    await sleep(100);
    assert.equal(await limiter.run('a', async () => 'back'), 'back');
  });

  it('propagates task errors without wedging the queue', async () => {
    const limiter = make({ getMinIntervalMs: () => 0 });
    await assert.rejects(limiter.run('a', async () => { throw new Error('boom'); }), /boom/);
    assert.equal(await limiter.run('a', async () => 'fine'), 'fine');
  });
});

describe('robots.txt checker', () => {
  const checker = (responder, extra = {}) => {
    const calls = [];
    const c = new RobotsChecker({
      userAgent: 'SerpAlterEgo',
      fetchText: async (url) => { calls.push(url); return responder(url); },
      ...extra,
    });
    return { c, calls };
  };

  it('applies Disallow/Allow rules with wildcards, and caches per origin', async () => {
    const { c, calls } = checker(() => ({ status: 200, body: 'User-agent: *\nDisallow: /search\nAllow: /search/about\nDisallow: /*?secret=\n' }));
    assert.equal((await c.check('https://g.example/search?q=x')).status, 'disallowed');
    assert.equal((await c.check('https://g.example/search/about')).status, 'allowed');
    assert.equal((await c.check('https://g.example/finance/quote/X')).status, 'allowed');
    assert.equal((await c.check('https://g.example/finance?secret=1')).status, 'disallowed');
    assert.equal(calls.length, 1);
  });

  it('prefers a group naming our user agent over *', async () => {
    const { c } = checker(() => ({ status: 200, body: 'User-agent: *\nDisallow: /\n\nUser-agent: SerpAlterEgo\nAllow: /\n' }));
    assert.equal((await c.check('https://g.example/anything')).status, 'allowed');
  });

  it('treats 4xx as "no robots.txt" and 5xx / network errors as unavailable', async () => {
    assert.equal((await checker(() => ({ status: 404, body: '' })).c.check('https://a.example/x')).status, 'allowed');
    assert.equal((await checker(() => ({ status: 503, body: '' })).c.check('https://a.example/x')).status, 'unavailable');
    const failing = checker(() => { throw new Error('ECONNREFUSED'); });
    const r = await failing.c.check('https://a.example/x');
    assert.equal(r.status, 'unavailable');
    assert.match(r.reason, /ECONNREFUSED/);
  });

  it('retries a failed fetch only after the failure TTL', async () => {
    let now = 1000;
    let fail = true;
    const { c, calls } = checker(() => (fail ? { status: 500, body: '' } : { status: 200, body: 'User-agent: *\nAllow: /\n' }), { now: () => now, failTtlMs: 100 });
    assert.equal((await c.check('https://a.example/x')).status, 'unavailable');
    fail = false;
    assert.equal((await c.check('https://a.example/x')).status, 'unavailable');
    now += 200;
    assert.equal((await c.check('https://a.example/x')).status, 'allowed');
    assert.equal(calls.length, 2);
  });
});

describe('settings store', () => {
  const defaults = { headless: false, fallbackToHeadless: false, robotsPolicy: 'enforce', minIntervalMs: 2500, cacheTtlSeconds: 300 };
  const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'serp-settings-')), 'settings.json');

  it('validates updates atomically', () => {
    const s = new SettingsStore({ defaults });
    assert.throws(() => s.update({ headless: 'maybe' }), { code: 'INVALID_PARAMETER' });
    assert.throws(() => s.update({ robotsPolicy: 'sometimes' }), { code: 'INVALID_PARAMETER' });
    assert.throws(() => s.update({ minIntervalMs: -1 }), { code: 'INVALID_PARAMETER' });
    assert.throws(() => s.update({ nope: 1 }), { code: 'INVALID_PARAMETER' });
    assert.throws(() => s.update({ headless: true, robotsPolicy: 'bad' }));
    assert.equal(s.get('headless'), false, 'a rejected update changes nothing');
    assert.equal(s.update({ headless: 'true', minIntervalMs: '100' }).headless, true);
    assert.equal(s.get('minIntervalMs'), 100);
  });

  it('rejects invalid defaults at startup', () => {
    assert.throws(() => new SettingsStore({ defaults: { ...defaults, robotsPolicy: 'maybe' } }), { code: 'INVALID_PARAMETER' });
  });

  it('notifies listeners, persists, reloads and resets', () => {
    const file = tmpFile();
    const s = new SettingsStore({ defaults, filePath: file });
    const seen = [];
    s.onChange((now, before) => seen.push([before.headless, now.headless]));
    s.update({ headless: true });
    assert.deepEqual(seen, [[false, true]]);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).headless, true);
    assert.equal(new SettingsStore({ defaults, filePath: file }).get('headless'), true, 'persisted value wins over env default');
    s.reset();
    assert.equal(s.get('headless'), false);
    assert.equal(fs.existsSync(file), false);
  });

  it('ignores a corrupt settings file', () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{ not json');
    assert.equal(new SettingsStore({ defaults, filePath: file }).get('headless'), false);
  });
});

describe('misc units', () => {
  it('TtlCache expires entries and evicts the least recently used', () => {
    let now = 0;
    const c = new TtlCache({ max: 2, now: () => now });
    c.set('a', 1, 100);
    c.set('b', 2, 100);
    c.get('a');
    c.set('c', 3, 100);
    assert.equal(c.get('b'), undefined);
    assert.equal(c.get('a'), 1);
    now = 150;
    assert.equal(c.get('a'), undefined);
  });

  it('HttpFetcher classifies timeouts and network errors', async () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    const timeout = new HttpFetcher({ config, fetchImpl: async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; } });
    await assert.rejects(timeout.get('http://x.example/'), { code: 'UPSTREAM_TIMEOUT', status: 504 });
    const dns = new HttpFetcher({ config, fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); } });
    await assert.rejects(dns.get('http://x.example/'), (e) => e.code === 'UPSTREAM_NETWORK_ERROR' && /ENOTFOUND/.test(e.message));
  });

  it('HttpFetcher enforces the body size limit', async () => {
    const config = loadConfig({ NODE_ENV: 'test', HTTP_MAX_BODY_BYTES: '10' });
    const big = new HttpFetcher({ config, fetchImpl: async () => new Response('x'.repeat(100)) });
    await assert.rejects(big.get('http://x.example/'), { code: 'UPSTREAM_HTTP_ERROR' });
  });

  it('redacts api_key from logged URLs', () => {
    assert.equal(redactUrl('/search?q=x&api_key=SECRET&hl=en'), '/search?q=x&api_key=[redacted]&hl=en');
  });

  it('encodes uule for a canonical location name', () => {
    assert.equal(encodeUule('Austin, Texas, United States'), 'w+CAIQICIcQXVzdGluLCBUZXhhcywgVW5pdGVkIFN0YXRlcw');
  });

  it('rejects bad environment values for the robots policy at startup', () => {
    assert.throws(() => new SettingsStore({ defaults: loadConfig({ ROBOTS_POLICY: 'nope' }).settings }), { code: 'INVALID_PARAMETER' });
  });
});
