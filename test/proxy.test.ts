import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { loadConfig } from '../src/config.js';
import type { BrowserLauncher } from '../src/scraper/browser.js';
import {
  applyGlobalProxy,
  browserProxyArgs,
  browserProxyAuth,
  parseProxy,
  redactProxy,
} from '../src/scraper/proxy.js';

describe('parseProxy', () => {
  it('returns null for unset / empty values', () => {
    assert.equal(parseProxy(null), null);
    assert.equal(parseProxy(undefined), null);
    assert.equal(parseProxy(''), null);
    assert.equal(parseProxy('   '), null);
  });

  it('accepts a bare host:port as http://', () => {
    const u = parseProxy('proxy.example:8080');
    assert.ok(u);
    assert.equal(u.protocol, 'http:');
    assert.equal(u.host, 'proxy.example:8080');
  });

  it('keeps credentials and scheme from a full URL', () => {
    const u = parseProxy('http://user:pass@proxy.example:8080');
    assert.ok(u);
    assert.equal(u.username, 'user');
    assert.equal(u.password, 'pass');
  });

  it('supports socks5', () => {
    const u = parseProxy('socks5://proxy.example:1080');
    assert.ok(u);
    assert.equal(u.protocol, 'socks5:');
  });

  it('rejects an unparseable value', () => {
    assert.equal(parseProxy('not a proxy'), null);
    assert.equal(parseProxy('http://'), null);
  });
});

describe('redactProxy', () => {
  it('hides credentials in the log form', () => {
    const u = parseProxy('http://user:secretpw@proxy.example:8080');
    assert.ok(u);
    const shown = redactProxy(u);
    assert.ok(!shown.includes('secretpw'), 'must never log the password');
    assert.ok(!shown.includes('user'), 'must never log the username');
    assert.ok(shown.includes('proxy.example:8080'));
  });

  it('leaves a credential-free proxy readable', () => {
    const u = parseProxy('http://proxy.example:8080');
    assert.ok(u);
    assert.equal(redactProxy(u), 'http://proxy.example:8080');
  });
});

describe('browser proxy launch wiring', () => {
  it('strips credentials from --proxy-server (Chrome takes them via authenticate)', () => {
    const config = loadConfig({ NODE_ENV: 'test', PROXY_URL: 'http://user:pass@proxy.example:8080' });
    assert.deepEqual(browserProxyArgs(config), ['--proxy-server=http://proxy.example:8080']);
  });

  it('returns no proxy arg when PROXY_URL is unset', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    assert.deepEqual(browserProxyArgs(config), []);
    assert.equal(browserProxyAuth(config), null);
  });

  it('exposes credentials for page.authenticate()', () => {
    const config = loadConfig({ NODE_ENV: 'test', PROXY_URL: 'http://user:pass@proxy.example:8080' });
    assert.deepEqual(browserProxyAuth(config), { username: 'user', password: 'pass' });
  });

  it('gives no auth for a credential-free proxy', () => {
    const config = loadConfig({ NODE_ENV: 'test', PROXY_URL: 'http://proxy.example:8080' });
    assert.equal(browserProxyAuth(config), null);
  });
});

describe('applyGlobalProxy', () => {
  it('is a no-op without PROXY_URL (does not touch the global dispatcher)', () => {
    const before = getGlobalDispatcher();
    const config = loadConfig({ NODE_ENV: 'test' });
    assert.equal(applyGlobalProxy(config), false);
    assert.equal(getGlobalDispatcher(), before, 'must leave the global dispatcher alone');
  });

  it('goes direct on an unusable PROXY_URL instead of failing', () => {
    const before = getGlobalDispatcher();
    const config = loadConfig({ NODE_ENV: 'test', PROXY_URL: '   ' });
    assert.equal(applyGlobalProxy(config), false);
    assert.equal(getGlobalDispatcher(), before);
  });

  it('points the global dispatcher at the proxy when PROXY_URL is set (restores afterwards)', () => {
    const before = getGlobalDispatcher();
    try {
      const config = loadConfig({ NODE_ENV: 'test', PROXY_URL: 'http://127.0.0.1:9' });
      assert.equal(applyGlobalProxy(config), true, 'valid proxy should apply');
      assert.notEqual(getGlobalDispatcher(), before, 'global dispatcher should now be the ProxyAgent');
    } finally {
      setGlobalDispatcher(before); // never leak a proxy into the other tests
    }
  });
});

describe('BrowserManager launch args', () => {
  it('passes the stealth flag and proxy arg through to Chromium', async () => {
    const captured: { args?: string[] } = {};
    const launcher: BrowserLauncher = (async (options: { args?: string[] }) => {
      captured.args = options.args;
      let current = '';
      const newPage = async () => ({
        setUserAgent: async () => {},
        setExtraHTTPHeaders: async () => {},
        setCookie: async () => {},
        setRequestInterception: async () => {},
        on() {},
        goto: async (url: string) => {
          current = url;
          return { status: () => 200 };
        },
        url: () => current,
        content: async () => '<html><body>ok</body></html>',
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

    const config = loadConfig({
      NODE_ENV: 'test',
      PROXY_URL: 'http://user:pass@proxy.example:8080',
      BROWSER_STEALTH: 'true',
    });
    const { BrowserManager } = await import('../src/scraper/browser.js');
    const manager = new BrowserManager({ config, launcher });
    await manager.render('https://example.com/');

    const args = captured.args ?? [];
    assert.ok(args.includes('--disable-blink-features=AutomationControlled'), `stealth flag missing: ${JSON.stringify(args)}`);
    assert.ok(
      args.some((a) => a.startsWith('--proxy-server=http://proxy.example:8080')),
      `proxy arg missing: ${JSON.stringify(args)}`,
    );
    assert.ok(!args.some((a) => a.includes('pass')), 'proxy credentials must not appear in launch args');
  });
});
