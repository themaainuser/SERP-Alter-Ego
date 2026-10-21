import type { Config } from '../config.js';
import { ScraperError } from '../errors.js';

export interface HttpResponse {
  status: number;
  url: string;
  headers: Headers;
  body: string;
}

export type FetchImpl = typeof globalThis.fetch;

/**
 * Lightweight HTTP client (Node's built-in fetch) used when headless mode is OFF.
 * Returns `{ status, url, headers, body }` for any HTTP status; only transport-level
 * problems (DNS, refused, timeout, oversized body) throw.
 */
export class HttpFetcher {
  private readonly config: Config;
  private readonly fetchImpl: FetchImpl;

  constructor({ config, fetchImpl = globalThis.fetch }: { config: Config; fetchImpl?: FetchImpl }) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async get(url: string, { headers = {}, timeoutMs = this.config.http.timeoutMs }: { headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<HttpResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'user-agent': this.config.userAgent,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
          ...headers,
        },
      });
      const body = await readLimited(res, this.config.http.maxBodyBytes);
      return { status: res.status, url: res.url || url, headers: res.headers, body };
    } catch (err) {
      throw classifyNetworkError(err, url, timeoutMs);
    }
  }
}

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (declared > maxBytes) throw new ScraperError('UPSTREAM_HTTP_ERROR', `Response too large (${declared} bytes).`, { details: { retryable: false } });
  if (!res.body) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > maxBytes) throw new ScraperError('UPSTREAM_HTTP_ERROR', `Response exceeded ${maxBytes} bytes.`, { details: { retryable: false } });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function classifyNetworkError(err: unknown, url: string, timeoutMs: number): ScraperError {
  if (err instanceof ScraperError) return err;
  const host = safeHost(url);
  const name = (err as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new ScraperError('UPSTREAM_TIMEOUT', `Request to ${host} timed out after ${timeoutMs}ms.`, { cause: err });
  }
  const e = err as { code?: string; cause?: { code?: string } } | null;
  const code = e?.cause?.code || e?.code;
  const detail = code ? ` (${code})` : '';
  return new ScraperError('UPSTREAM_NETWORK_ERROR', `Could not reach ${host}${detail}.`, { cause: err });
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'upstream';
  }
}
