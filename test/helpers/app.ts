import http from 'node:http';
import { type App, type AppOverrides, createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { BrowserLauncher } from '../../src/scraper/browser.js';
import { listenSafe } from './safePort.js';

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
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent', // TEST_LOG_LEVEL=error surfaces swallowed server errors while debugging
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
  const server = http.createServer(instance.app);
  const port = await listenSafe(server);
  const base = `http://127.0.0.1:${port}`;
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
export function fakeLauncher(
  render: (url: string) => string,
  hooks: { onWaitForFunction?: () => void } = {},
): { launcher: BrowserLauncher; state: FakeBrowserState } {
  const state: FakeBrowserState = { launches: 0, renders: [], closed: 0 };
  const launcher = async () => {
    state.launches++;
    let connected = true;
    const newContext = async () => {
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
            waitForFunction: async () => {
              hooks.onWaitForFunction?.();
            },
            url: () => current,
            content: async () => render(current),
            evaluate: async () => true,
            close: async () => {},
          };
        },
        close: async () => {},
      };
    };
    return {
      get connected() {
        return connected;
      },
      on() {},
      process: () => null,
      async createBrowserContext() {
        return newContext();
      },
      async defaultBrowserContext() {
        return newContext();
      },
      async close() {
        connected = false;
        state.closed++;
      },
    };
  };
  return { launcher: launcher as unknown as BrowserLauncher, state };
}

