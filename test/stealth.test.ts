import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, Page } from 'puppeteer';
import { applyPageIdentity } from '../src/scraper/fingerprint.js';
import { applyStealth, stealthLaunchArgs, STEALTH_SCRIPT } from '../src/scraper/stealth.js';
import { findChrome, NO_CHROME_MESSAGE } from './helpers/chrome.js';
import { listenSafe } from './helpers/safePort.js';

const asPage = (o: object) => o as unknown as Page;
const chrome = await findChrome();

describe('stealthLaunchArgs', () => {
  it('adds the AutomationControlled flag when enabled (drops navigator.webdriver)', () => {
    assert.deepEqual(stealthLaunchArgs(true), ['--disable-blink-features=AutomationControlled']);
  });

  it('adds nothing when disabled', () => {
    assert.deepEqual(stealthLaunchArgs(false), []);
  });
});

describe('applyStealth', () => {
  it('injects the script before page scripts when enabled', async () => {
    let injected = '';
    const page = asPage({ evaluateOnNewDocument: async (s: string) => { injected = s; } });
    await applyStealth(page, true);
    assert.ok(injected, 'should have injected a script');
    assert.ok(injected.includes('chrome.runtime'), 'should fill the window.chrome.runtime gap');
    assert.ok(injected.includes('permissions'), 'should align the permission-query gap');
  });

  it('does nothing when disabled', async () => {
    let called = false;
    const page = asPage({ evaluateOnNewDocument: async () => { called = true; } });
    await applyStealth(page, false);
    assert.equal(called, false, 'must not inject when disabled');
  });

  it('never throws when the page cannot take the script (best-effort)', async () => {
    // A page without evaluateOnNewDocument must not abort the render.
    await applyStealth(asPage({}), true);
  });

  it('exposes a runnable, self-contained script', () => {
    // Must not rely on anything outside its own IIFE (it runs before page scripts).
    assert.ok(STEALTH_SCRIPT.trimStart().startsWith('(() => {'));
    assert.ok(STEALTH_SCRIPT.trimEnd().endsWith('})();'));
    // Sanity: it must actually parse as JS.
    assert.doesNotThrow(() => new Function(STEALTH_SCRIPT));
  });
});

describe('browser fingerprint battery (real Chrome)', { skip: chrome ? false : NO_CHROME_MESSAGE }, () => {
  // The identity every production page gets — keep in step with DEFAULT_UA in src/config.ts.
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
  const ACCEPT_LANGUAGE = 'en-US,en;q=0.9';
  let browser: Browser;
  let server: http.Server;
  let origin = '';
  let captured: Array<http.IncomingHttpHeaders> = [];

  before(async () => {
    // A local origin that records request headers — client hints only show up on the wire.
    server = http.createServer((req, res) => {
      captured.push(req.headers);
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<!DOCTYPE html><html><head><title>battery</title></head><body>battery</body></html>');
    });
    const port = await listenSafe(server);
    origin = `http://127.0.0.1:${port}`;
    const { default: puppeteer } = await import('puppeteer');
    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      // Mirrors the production launch: stealth flag first, deterministic language, CI-safe shm.
      args: [...stealthLaunchArgs(true), '--lang=en-US', '--no-first-run', '--disable-dev-shm-usage'],
    });
  });
  after(async () => {
    await browser?.close();
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** A fresh page carrying the production identity: stealth script + UA/platform/client hints. */
  const identityPage = async (): Promise<Page> => {
    const page = await browser.newPage();
    await applyStealth(page, true);
    await applyPageIdentity(page, { userAgent: UA, acceptLanguage: ACCEPT_LANGUAGE });
    return page;
  };

  it('does not leak webdriver and exposes window.chrome.runtime', async () => {
    const page = await identityPage();
    try {
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      const probe = JSON.parse((await page.evaluate(
        `JSON.stringify({ webdriver: navigator.webdriver, connect: typeof chrome?.runtime?.connect })`,
      )) as string) as { webdriver?: boolean; connect: string };
      assert.ok(!probe.webdriver, `navigator.webdriver must not be truthy (got ${String(probe.webdriver)})`);
      assert.equal(probe.connect, 'function', 'window.chrome.runtime.connect missing');
    } finally {
      await page.close();
    }
  });

  it('matches UA, platform and languages to the configured identity', async () => {
    const page = await identityPage();
    try {
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      const view = JSON.parse((await page.evaluate(
        `JSON.stringify({ ua: navigator.userAgent, platform: navigator.platform, languages: [...navigator.languages], uaData: navigator.userAgentData?.platform ?? null })`,
      )) as string) as { ua: string; platform: string; languages: string[]; uaData: string | null };
      assert.equal(view.ua, UA, 'navigator.userAgent must be the configured UA');
      assert.equal(view.platform, 'Win32', 'navigator.platform must agree with the Windows UA');
      assert.equal(view.languages[0], 'en-US', 'navigator.languages must follow accept-language');
      assert.equal(view.uaData, 'Windows', 'userAgentData.platform must agree with the Windows UA');
    } finally {
      await page.close();
    }
  });

  it('sends client-hints headers that agree with the configured UA', async () => {
    captured = [];
    const page = await identityPage();
    try {
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      assert.ok(captured.length > 0, 'the local server should have seen the request');
      const headers = captured[captured.length - 1]!;
      assert.equal(headers['sec-ch-ua-platform'], '"Windows"', 'Sec-CH-UA-Platform must match the UA');
      assert.equal(headers['sec-ch-ua-mobile'], '?0');
      assert.match(String(headers['sec-ch-ua']), /"Google Chrome";\s*v="138"/, "Sec-CH-UA must advertise the UA's Chrome major");
    } finally {
      await page.close();
    }
  });
});
