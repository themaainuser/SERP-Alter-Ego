import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserManager, type BrowserLauncher } from '../src/scraper/browser.js';
import { loadConfig } from '../src/config.js';

/**
 * A fake browser that records every interaction `render()` has with the page, so a test can
 * assert the *sequence* of the human-like search flow (open homepage -> type -> submit ->
 * navigate to the full search URL) without a real browser or network.
 */
function recorder() {
  const calls: string[] = [];
  const launcher: BrowserLauncher = (async () => {
    let current = '';
    const newPage = async () => ({
      setUserAgent: async () => {},
      setExtraHTTPHeaders: async () => {},
      setCookie: async () => {},
      setRequestInterception: async () => {},
      on() {},
      off() {},
      goto: async (url: string) => {
        calls.push(`goto:${url}`);
        current = url;
        return { status: () => 200 };
      },
      waitForSelector: async (selector: string) => {
        calls.push(`wait:${selector}`);
      },
      type: async (_selector: string, text: string) => {
        calls.push(`type:${text}`);
      },
      keyboard: {
        press: async (key: string) => {
          calls.push(`key:${key}`);
        },
      },
      waitForNavigation: async () => {
        calls.push('waitNav');
      },
      waitForNetworkIdle: async () => {},
      url: () => current,
      content: async () => '<html><body><div id="rso">results</div></body></html>',
      evaluate: async () => true,
      close: async () => {},
    });
    const context = async () => ({ newPage, close: async () => {} });
    return {
      get connected() {
        return true;
      },
      on() {},
      process: () => null,
      createBrowserContext: context,
      defaultBrowserContext: context,
      close: async () => {},
    };
  }) as unknown as BrowserLauncher;
  return { calls, launcher };
}

const SEARCH = 'https://www.google.com/search?q=best+coffee+grinders&num=10&hl=en&gl=us';

describe('human-like search navigation', () => {
  it('opens the homepage, types the query, submits, then lands on the full search URL', async () => {
    const { calls, launcher } = recorder();
    const config = loadConfig({ NODE_ENV: 'test', BROWSER_HUMAN_SEARCH: 'true' });
    const manager = new BrowserManager({ config, launcher });

    const page = await manager.render(SEARCH);

    assert.match(page.html, /results/);
    assert.equal(calls[0], 'goto:https://www.google.com/', 'should start on the homepage, not deep-link to /search');
    assert.ok(
      calls.some((c) => c.startsWith('wait:') && c.includes('textarea[name="q"]')),
      'should wait for the homepage search box',
    );
    assert.ok(calls.includes('type:best coffee grinders'), 'should type the decoded query');
    // Exactly one /search request: the final goto to the target URL. No Enter-driven search
    // before it — a second back-to-back /search is the rapid re-search pattern that looks
    // automated and only yields a page we'd discard.
    assert.equal(calls.filter((c) => c.startsWith('goto:') && c.includes('/search')).length, 1, 'should fire exactly one /search navigation');
    assert.equal(
      calls[calls.length - 1],
      `goto:${SEARCH}`,
      'should finish by navigating to the exact target URL (so num/hl/gl/tbm are honoured)',
    );
    // The homepage visit must precede the search navigation — that ordering is the point.
    assert.ok(calls.indexOf('goto:https://www.google.com/') < calls.lastIndexOf(`goto:${SEARCH}`));
  });

  it('skips the warm-up entirely when BROWSER_HUMAN_SEARCH=false', async () => {
    const { calls, launcher } = recorder();
    const config = loadConfig({ NODE_ENV: 'test', BROWSER_HUMAN_SEARCH: 'false' });
    const manager = new BrowserManager({ config, launcher });

    await manager.render(SEARCH);

    assert.equal(calls[0], `goto:${SEARCH}`, 'should deep-link straight to the search URL');
    assert.ok(!calls.some((c) => c.startsWith('type:')), 'should not type into a search box');
    assert.ok(!calls.includes('key:Enter'), 'should not submit anything');
  });

  it('does not apply the flow to non-search URLs (news.google.com / other hosts)', async () => {
    const { calls, launcher } = recorder();
    const config = loadConfig({ NODE_ENV: 'test', BROWSER_HUMAN_SEARCH: 'true' });
    const manager = new BrowserManager({ config, launcher });

    await manager.render('https://news.google.com/search?q=breaking&hl=en-US');

    // news.google.com is not www.google.<tld> — it should navigate directly, no homepage warm-up.
    assert.equal(calls[0], 'goto:https://news.google.com/search?q=breaking&hl=en-US');
    assert.ok(!calls.some((c) => c.startsWith('type:')), 'should not use the homepage search box');
  });

  it('falls back to direct navigation if the search box never appears', async () => {
    const calls: string[] = [];
    const launcher: BrowserLauncher = (async () => {
      let current = '';
      const newPage = async () => ({
        setUserAgent: async () => {},
        setExtraHTTPHeaders: async () => {},
        setCookie: async () => {},
        setRequestInterception: async () => {},
        on() {},
        off() {},
        goto: async (url: string) => {
          calls.push(`goto:${url}`);
          current = url;
          return { status: () => 200 };
        },
        waitForSelector: async () => {
          throw new Error('search box not found');
        },
        type: async () => {
          calls.push('type');
        },
        keyboard: { press: async () => {} },
        waitForNavigation: async () => {},
        waitForNetworkIdle: async () => {},
        url: () => current,
        content: async () => '<html><body>ok</body></html>',
        evaluate: async () => true,
        close: async () => {},
      });
      const context = async () => ({ newPage, close: async () => {} });
      return {
        get connected() {
          return true;
        },
        on() {},
        process: () => null,
        createBrowserContext: context,
        defaultBrowserContext: context,
        close: async () => {},
      };
    }) as unknown as BrowserLauncher;

    const config = loadConfig({ NODE_ENV: 'test', BROWSER_HUMAN_SEARCH: 'true' });
    const manager = new BrowserManager({ config, launcher });

    const page = await manager.render(SEARCH);

    // Warm-up failed at the search box, but the real navigation still happened.
    assert.match(page.html, /ok/);
    assert.equal(calls[calls.length - 1], `goto:${SEARCH}`);
  });
});
