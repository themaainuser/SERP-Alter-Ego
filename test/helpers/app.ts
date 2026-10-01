import { type App, type AppOverrides, createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { BrowserLauncher } from '../../src/scraper/browser.js';

/** Parsed API response. `json` is deliberately `any`: tests probe deep into SerpApi-shaped payloads. */
export interface ApiResponse {
  status: number;
  headers: Headers;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
}

export interface TestApp extends App {
  base: string;
  get(pathAndQuery: string, init?: RequestInit): Promise<ApiResponse>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  patchSettings(patch: unknown): Promise<{ status: number; json: any }>;
  stop(): Promise<void>;
}

export interface StartAppOptions {
  upstream?: { url: string };
  env?: Record<string, string>;
  overrides?: AppOverrides;
}

/**
 * Start the real Express app on an ephemeral port, pointed at a fake upstream.
 * Fast defaults: no rate-limit gap, no retry delay, no persistence, silent logs.
 */
export async function startApp({ upstream, env = {}, overrides = {} }: StartAppOptions = {}): Promise<TestApp> {
  const config = loadConfig({
    NODE_ENV: 'test',
    RATE_MIN_INTERVAL_MS: '0',
    RATE_JITTER_MS: '0',
    HTTP_RETRY_BASE_MS: '1',
    HTTP_TIMEOUT_MS: '3000',
    ROBOTS_POLICY: 'enforce',
    CACHE_TTL_SECONDS: '0',
    ...(upstream ? { UPSTREAM_GOOGLE_URL: upstream.url, UPSTREAM_NEWS_URL: upstream.url } : {}),
    ...env,
  });
  const instance = createApp({ config, overrides });
  const server = await new Promise<ReturnType<typeof instance.app.listen>>((resolve) => {
    const s = instance.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test app failed to bind');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    ...instance,
    base,
    async get(pathAndQuery, init) {
      const res = await fetch(base + pathAndQuery, init);
      const text = await res.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: res.status, headers: res.headers, text, json };
    },
    async patchSettings(patch) {
      const res = await fetch(`${base}/api/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
      return { status: res.status, json: await res.json() };
    },
    async stop() {
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
      await instance.close();
    },
  };
}

export interface FakeBrowserState {
  launches: number;
  renders: string[];
  closed: number;
}

/**
 * A launcher that returns an in-memory fake browser; `render(url)` returns the DOM to serve.
 * Implements only the Puppeteer surface BrowserManager uses, so it is asserted to `BrowserLauncher` once here.
 */
export function fakeLauncher(render: (url: string) => string): { launcher: BrowserLauncher; state: FakeBrowserState } {
  const state: FakeBrowserState = { launches: 0, renders: [], closed: 0 };
  const launcher = async () => {
    state.launches++;
    let connected = true;
    return {
      get connected() {
        return connected;
      },
      on() {},
      process: () => null,
      async createBrowserContext() {
        return {
          async newPage() {
            let current = '';
            return {
              setUserAgent: async () => {},
              setExtraHTTPHeaders: async () => {},
              setCookie: async () => {},
              setRequestInterception: async () => {},
              on() {},
              off() {},
              goto: async (url: string) => {
                current = url;
                state.renders.push(url);
                return { status: () => 200 };
              },
              waitForSelector: async () => {},
              url: () => current,
              content: async () => render(current),
              evaluate: async () => true,
            };
          },
          close: async () => {},
        };
      },
      async close() {
        connected = false;
        state.closed++;
      },
    };
  };
  return { launcher: launcher as unknown as BrowserLauncher, state };
}

