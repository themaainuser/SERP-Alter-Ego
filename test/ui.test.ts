import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'puppeteer';
import { startApp, type TestApp } from './helpers/app.js';
import { findChrome, NO_CHROME_MESSAGE } from './helpers/chrome.js';
import { type FakeUpstream, fixture, html, startFakeUpstream } from './helpers/fakeUpstream.js';

const clientBundle = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js');
const chrome = await findChrome();

// The browser-side code (`client/app.ts`) is compiled by `npm run build:client`, which `npm test` runs first.
describe('web UI (compiled client in a real Chrome)', { skip: chrome ? false : NO_CHROME_MESSAGE }, () => {
  let browser: Browser;
  let page: Page;
  let upstream: FakeUpstream;
  let app: TestApp;
  let pageErrors: string[];

  before(async () => {
    assert.ok(fs.existsSync(clientBundle), 'public/app.js is missing: run `npm run build:client`');
    const { default: puppeteer } = await import('puppeteer');
    browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], defaultViewport: { width: 1360, height: 1000 } });
  });
  after(async () => {
    await browser?.close();
  });

  async function open(upstreamRoutes: Parameters<typeof startFakeUpstream>[0]): Promise<void> {
    upstream = await startFakeUpstream(upstreamRoutes);
    app = await startApp({ upstream });
    pageErrors = [];
    page = await browser.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.goto(`${app.base}/`, { waitUntil: 'networkidle0' });
  }
  afterEach(async () => {
    await page?.close();
    await app?.stop();
    await upstream?.close();
  });

  const financeRoutes = { '/finance/quote/GOOGL:NASDAQ': html(fixture('finance-googl.html')) };
  const text = async (selector: string): Promise<string> => (await page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`)) as string;
  const waitFor = (expression: string): Promise<unknown> => page.waitForFunction(expression, { timeout: 10000 });

  async function openFinanceTab(): Promise<void> {
    await page.evaluate(`[...document.querySelectorAll('#engine-tabs button')].find((b) => b.textContent === 'Finance').click()`);
  }
  async function searchFinance(): Promise<void> {
    await openFinanceTab();
    await page.click('#submit');
    await waitFor(`!document.getElementById('submit').disabled && !document.getElementById('result').hidden`);
  }

  it('renders a Finance search: summary, chart, key stats, and the request metadata', async () => {
    await open(financeRoutes);
    await searchFinance();
    assert.equal(await text('.quote .price'), '$344.08');
    assert.match(await text('.quote .name'), /Alphabet Inc Class A · GOOGL:NASDAQ/);
    assert.equal(await page.evaluate(`document.querySelectorAll('svg.sparkline path').length`), 2, 'the chart is drawn');
    assert.match(await text('#meta'), /mode\s*http/);
    assert.match(await text('#visual'), /Previous close/);
    assert.match(await text('#curl'), /engine=google_finance/);
    assert.deepEqual(pageErrors, []);
  });

  it('the headless switch changes the mode on the server immediately and can be switched back', async () => {
    await open(financeRoutes);
    assert.equal(await text('#mode-pill'), 'HTTP');

    await page.click('.switch');
    await waitFor(`document.getElementById('mode-pill').textContent === 'HEADLESS'`);
    assert.equal((await app.get('/api/settings')).json.headless, true);

    await page.click('.switch');
    await waitFor(`document.getElementById('mode-pill').textContent === 'HTTP'`);
    assert.equal((await app.get('/api/settings')).json.headless, false);
    assert.deepEqual(pageErrors, []);
  });

  it('shows the JS_REQUIRED error with a one-click "Turn headless ON" action, and a recent-searches entry', async () => {
    await open(financeRoutes);
    await openFinanceTab();
    await page.select('#f-window', '1Y');
    await page.click('#submit');
    await waitFor(`!document.getElementById('error').hidden`);
    assert.match(await text('#error'), /JS_REQUIRED/);
    assert.match(await text('#error'), /Turn headless ON and retry/);
    await waitFor(`document.querySelectorAll('#history li button').length > 0`);
    assert.match(await text('#history'), /JS_REQUIRED/);
    assert.deepEqual(pageErrors, []);
  });

  it('shows the robots.txt refusal and opens the settings dialog from it', async () => {
    await open({ ...financeRoutes, '/robots.txt': (_req, res) => void res.end('User-agent: *\nDisallow: /finance\n') });
    await searchFinance();
    assert.match(await text('#error'), /ROBOTS_DISALLOWED/);
    await page.evaluate(`[...document.querySelectorAll('#error button')].find((b) => b.textContent === 'Open settings').click()`);
    await waitFor(`document.getElementById('settings-dialog').open`);
    assert.equal(await page.evaluate(`document.getElementById('s-robots').value`), 'enforce');
    assert.deepEqual(pageErrors, []);
  });
});
