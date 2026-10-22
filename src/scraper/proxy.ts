import { ProxyAgent, setGlobalDispatcher } from "undici";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";

/**
 * One place to route outbound traffic through an HTTP(S)/SOCKS5 proxy (`PROXY_URL`).
 *
 * Two independent stacks leave this process, and both must go through the proxy or the real IP
 * leaks: the browser (Chromium's own network stack) and Node's `fetch` (used by HttpFetcher
 * when headless is OFF, and by the `/goto` resolver in every mode).
 *
 * - Chromium path: `browserProxyArgs()` → a `--proxy-server` launch flag, plus
 *   `browserProxyAuth()` → `page.authenticate()` for credentialed proxies.
 * - Node fetch path: `applyGlobalProxy()` → undici's global dispatcher.
 *
 * `setGlobalDispatcher` is used deliberately: Node's built-in `fetch` **rejects** a per-request
 * `dispatcher` option (`UND_ERR_INVALID_ARG`) but **honours** the global one — and setting it
 * once covers every fetch (HttpFetcher + resolver) with no per-call threading. Verified
 * empirically (a dead proxy turns every fetch into ECONNREFUSED). It is a no-op when `PROXY_URL`
 * is unset, so tests and direct connections are unaffected.
 */

/** Parse a proxy string into a URL. Tolerates a bare `host:port` (treated as `http://`). */
export function parseProxy(raw: string | null | undefined): URL | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

/** Credentials-safe form for logs (never log the raw proxy URL). */
export function redactProxy(url: URL): string {
  if (!url.username && !url.password) return `${url.protocol}//${url.host}`;
  return `${url.protocol}//***:***@${url.host}`;
}

/**
 * Point every Node `fetch` through the proxy. Returns true if applied.
 * Best-effort: a malformed/unusable `PROXY_URL` logs a warning and we go direct rather than
 * failing to start — a bad proxy should degrade, not take the whole app down.
 */
export function applyGlobalProxy(config: Config, logger?: Logger): boolean {
  const url = parseProxy(config.proxyUrl);
  if (!url) {
    if (config.proxyUrl) logger?.warn("PROXY_URL is not a usable proxy URL; going direct.", { proxy: config.proxyUrl });
    return false;
  }
  try {
    setGlobalDispatcher(new ProxyAgent(url.toString()));
    logger?.info("Outbound HTTP routed through proxy", { proxy: redactProxy(url) });
    return true;
  } catch (err) {
    logger?.warn("Could not create the proxy agent; going direct.", {
      proxy: redactProxy(url),
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Chromium launch flag pointing at the proxy. Credentials are stripped — Chrome ignores
 * userinfo in `--proxy-server` and takes them from `page.authenticate()` instead.
 * Note: Chrome only authenticates HTTP(S) proxies this way; SOCKS5 runs credential-free.
 */
export function browserProxyArgs(config: Config): string[] {
  const url = parseProxy(config.proxyUrl);
  if (!url) return [];
  return [`--proxy-server=${url.protocol}//${url.host}`];
}

/** Proxy credentials for `page.authenticate()`, or null when there are none. */
export function browserProxyAuth(config: Config): { username: string; password: string } | null {
  const url = parseProxy(config.proxyUrl);
  if (!url || (!url.username && !url.password)) return null;
  return { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
}
