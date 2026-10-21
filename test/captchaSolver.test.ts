import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer';
import { loadConfig } from '../src/config.js';
import { extractSitekey, solveSorryCaptcha, solverEnabled } from '../src/scraper/captchaSolver.js';

const KEY = '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI';

const browserCfg = (env: Record<string, string | undefined> = {}) =>
  loadConfig({ NODE_ENV: 'test', ...env }).browser;

/** A fake CAPTCHA page: records the injection call and (optionally) "redirects" off /sorry/. */
function fakePage({ html, leavesSorry = true }: { html?: string; leavesSorry?: boolean } = {}) {
  const SORRY = 'https://www.google.com/sorry/index?continue=https%3A%2F%2Fwww.google.com%2Fsearch%3Fq%3Dx';
  const RESULTS = 'https://www.google.com/search?q=x';
  let injected = false;
  const page = {
    url: () => (injected && leavesSorry ? RESULTS : SORRY),
    content: async () => html ?? `<div class="g-recaptcha" data-sitekey="${KEY}"></div>`,
    evaluate: async (_fn: unknown, _token?: unknown) => {
      injected = true;
      return true;
    },
  } as unknown as Page;
  return { page, wasInjected: () => injected };
}

/** Fake 2Captcha API: in.php hands back a task id, res.php hands back a token. */
function solverFetch() {
  const calls: string[] = [];
  const fetchImpl = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/in.php')) return { json: async () => ({ status: 1, request: 'CAPID123' }) } as unknown as Response;
    return { json: async () => ({ status: 1, request: 'TOKEN_ABC' }) } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

describe('solverEnabled', () => {
  it('is off by default (human-in-loop stays the default solver)', () => {
    assert.equal(solverEnabled(browserCfg()), false);
  });

  it('requires BOTH a known provider and an API key', () => {
    assert.equal(solverEnabled(browserCfg({ CAPTCHA_SOLVER: '2captcha', CAPTCHA_SOLVER_API_KEY: 'k' })), true);
    assert.equal(solverEnabled(browserCfg({ CAPTCHA_SOLVER: '2captcha' })), false);
    assert.equal(solverEnabled(browserCfg({ CAPTCHA_SOLVER_API_KEY: 'k' })), false);
  });

  it('treats the provider case-insensitively but rejects unknown names', () => {
    assert.equal(solverEnabled(browserCfg({ CAPTCHA_SOLVER: '2CAPTCHA', CAPTCHA_SOLVER_API_KEY: 'k' })), true);
    assert.equal(solverEnabled(browserCfg({ CAPTCHA_SOLVER: 'nonsense', CAPTCHA_SOLVER_API_KEY: 'k' })), false);
  });
});

describe('extractSitekey', () => {
  it('reads a data-sitekey attribute', () => {
    const html = `<div class="g-recaptcha" data-sitekey="${KEY}"></div>`;
    assert.equal(extractSitekey(html), KEY);
  });

  it('reads the k= param from a reCAPTCHA anchor URL', () => {
    const html = `<iframe src="https://www.google.com/recaptcha/api2/anchor?k=${KEY}&amp;co=aC8"></iframe>`;
    assert.equal(extractSitekey(html), KEY);
  });

  it('returns null when the page has no sitekey', () => {
    assert.equal(extractSitekey('<html><body>ordinary page</body></html>'), null);
  });
});

describe('solveSorryCaptcha', () => {
  it('solves end to end: sitekey -> token -> injection -> leaves /sorry/', async () => {
    const { page, wasInjected } = fakePage();
    const { fetchImpl, calls } = solverFetch();

    const solved = await solveSorryCaptcha(page, browserCfg({ CAPTCHA_SOLVER: '2captcha', CAPTCHA_SOLVER_API_KEY: 'k' }), undefined, { fetchImpl });

    assert.equal(solved, true);
    assert.equal(wasInjected(), true, 'should have injected the token');
    assert.ok(calls.some((u) => u.includes('/in.php')), 'should submit the task');
    assert.ok(calls.some((u) => u.includes('/res.php')), 'should poll for the token');
  });

  it('never contacts the solver when the page has no sitekey', async () => {
    const { page, wasInjected } = fakePage({ html: '<html><body>no captcha</body></html>' });
    const { fetchImpl, calls } = solverFetch();

    const solved = await solveSorryCaptcha(page, browserCfg({ CAPTCHA_SOLVER: '2captcha', CAPTCHA_SOLVER_API_KEY: 'k' }), undefined, { fetchImpl });

    assert.equal(solved, false);
    assert.equal(wasInjected(), false);
    assert.equal(calls.length, 0, 'must not call the paid API without a target');
  });

  it('returns false (not throws) when the solver rejects the task', async () => {
    const { page } = fakePage();
    const fetchImpl = (async (input: unknown) => {
      if (String(input).includes('/in.php')) {
        return { json: async () => ({ status: 0, request: 'ERROR_WRONG_USER_KEY' }) } as unknown as Response;
      }
      return { json: async () => ({ status: 0, request: 'CAPCHA_NOT_READY' }) } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

    const solved = await solveSorryCaptcha(
      page,
      browserCfg({ CAPTCHA_SOLVER: '2captcha', CAPTCHA_SOLVER_API_KEY: 'bad' }),
      undefined,
      { fetchImpl },
    );
    assert.equal(solved, false);
  });

  it('does nothing when no API key is configured', async () => {
    const { page, wasInjected } = fakePage();
    const { fetchImpl, calls } = solverFetch();

    const solved = await solveSorryCaptcha(page, browserCfg({ CAPTCHA_SOLVER: '2captcha' }), undefined, { fetchImpl });

    assert.equal(solved, false);
    assert.equal(wasInjected(), false);
    assert.equal(calls.length, 0);
  });

  it('reports failure when the page stays on /sorry/ after injection', async () => {
    const { page } = fakePage({ leavesSorry: false });
    const { fetchImpl } = solverFetch();

    const solved = await solveSorryCaptcha(
      page,
      browserCfg({ CAPTCHA_SOLVER: '2captcha', CAPTCHA_SOLVER_API_KEY: 'k', CAPTCHA_SOLVER_TIMEOUT_MS: '600' }),
      undefined,
      { fetchImpl },
    );

    assert.equal(solved, false, 'still on /sorry/ means not solved');
  });
});
