import type { HTTPResponse, Page } from 'puppeteer';
import { badRequest, ScraperError } from '../errors.js';
import { parseError } from '../parsers/common.js';
import { containsGraph, decodeBatchExecute, parseFinance } from '../parsers/googleFinance.js';
import { googleOrigin, readCommon, reader } from '../serpapi/params.js';
import { type BaseParams, defineEngine, type PageExtras } from '../types.js';

const WINDOWS = ['1D', '5D', '1M', '6M', 'YTD', '1Y', '5Y', 'MAX'] as const;
type ChartWindow = (typeof WINDOWS)[number];
const SYMBOL = /^[A-Za-z0-9.^&_-]{1,30}(:[A-Za-z0-9_]{1,30})?$/;

export interface FinanceParams extends BaseParams {
  q: string;
  window: ChartWindow;
}

// Only the DOM surface used inside `page.evaluate`, which runs in the browser rather than in Node.
declare const document: {
  querySelectorAll(selector: string): ArrayLike<{ getAttribute(name: string): string | null; click(): void }>;
};

/**
 * Non-default chart windows are loaded by the page via XHR. Click the window tab and capture
 * the batchexecute responses, which use the same positional format as the embedded data.
 */
function windowCapture(window: ChartWindow): (page: Page) => Promise<PageExtras> {
  return async (page) => {
    const bodies: string[] = [];
    const onResponse = async (res: HTTPResponse): Promise<void> => {
      if (!res.url().includes('batchexecute')) return;
      try {
        bodies.push(await res.text());
      } catch {
        /* response body unavailable */
      }
    };
    const loaded = (): boolean => bodies.some((b) => decodeBatchExecute(b).some(containsGraph));
    page.on('response', onResponse);
    try {
      // The tab exists in the server-rendered HTML before its click handler is attached, so retry the click.
      for (let attempt = 0; attempt < 4 && !loaded(); attempt++) {
        const clicked = await page.evaluate((label: string) => {
          const tab = Array.from(document.querySelectorAll('button[role="tab"]')).find((b) => b.getAttribute('aria-label') === label);
          tab?.click();
          return Boolean(tab);
        }, window);
        if (!clicked) throw parseError(`Could not find the "${window}" chart tab on the Google Finance page.`);
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline && !loaded()) await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      page.off('response', onResponse);
    }
    return { payloads: bodies.flatMap((b) => decodeBatchExecute(b)) };
  };
}

/** `engine=google_finance`: `q` is `TICKER:EXCHANGE` (e.g. `GOOGL:NASDAQ`) or a pair like `EUR-USD`. */
export const googleFinance = defineEngine<FinanceParams>({
  id: 'google_finance',
  normalize(raw, defaults) {
    const r = reader(raw);
    const q = r.str('q', { max: 60 });
    if (!q) throw badRequest('Missing query `q` parameter.');
    if (!SYMBOL.test(q)) throw badRequest('Invalid `q` parameter: expected `TICKER:EXCHANGE` (e.g. `GOOGL:NASDAQ`) or a pair such as `EUR-USD`.');
    const common = readCommon(r, defaults);
    return { engine: 'google_finance', q, ...common, window: r.enum('window', WINDOWS) ?? '1D' };
  },
  echo(p) {
    return { engine: p.engine, q: p.q, hl: p.hl, ...(p.window !== '1D' ? { window: p.window } : {}), device: p.device };
  },
  plan(p, { config, mode }) {
    if (mode === 'http' && p.window !== '1D') {
      throw new ScraperError('JS_REQUIRED', `\`window=${p.window}\` is loaded by JavaScript: turn headless mode ON (or enable the headless fallback). Only the default \`1D\` window works in HTTP mode.`);
    }
    const u = new URL(`/finance/quote/${encodeURIComponent(p.q).replace('%3A', ':')}`, googleOrigin(p.google_domain, config));
    u.searchParams.set('hl', p.hl);
    return {
      googleUrl: u.href,
      request: {
        url: u.href,
        readySelector: p.window === '1D' ? undefined : 'button[role="tab"]',
        afterLoad: p.window === '1D' ? undefined : windowCapture(p.window),
        acceptLanguage: `${p.hl},en;q=0.8`,
      },
      parse(page) {
        const parsed = parseFinance(page.html, {
          symbol: p.q,
          hl: p.hl,
          extras: page.extras && { payloads: page.extras.payloads, windowOnly: true },
        });
        if (parsed.empty) return { data: {}, empty: true, emptyMessage: "Google Finance hasn't returned any results for this query." };
        if (page.extras && !parsed.graph.length) throw parseError(`Google Finance did not return chart data for window ${p.window}.`);
        return { data: parsed, empty: false };
      },
    };
  },
});
