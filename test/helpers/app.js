import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';

/**
 * Start the real Express app on an ephemeral port, pointed at a fake upstream.
 * Fast defaults: no rate-limit gap, no retry delay, no persistence, silent logs.
 */
export async function startApp({ upstream, env = {}, overrides = {} } = {}) {
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
  const server = await new Promise((resolve) => {
    const s = instance.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = {
    ...instance,
    base,
    async get(pathAndQuery, init) {
      const res = await fetch(base + pathAndQuery, init);
      const text = await res.text();
      let json;
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
      await new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      });
      await instance.close();
    },
  };
  return api;
}

/** A launcher that returns an in-memory fake browser; `render(url)` returns the DOM to serve. */
export function fakeLauncher(render) {
  const state = { launches: 0, renders: [], closed: 0 };
  const launcher = async () => {
    state.launches++;
    let connected = true;
    return {
      get connected() {
        return connected;
      },
      on() {},
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
              goto: async (url) => {
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
  return { launcher, state };
}
