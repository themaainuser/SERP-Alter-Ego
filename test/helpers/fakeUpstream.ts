import fs from 'node:fs';
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
export const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

export type Responder = (req: IncomingMessage, res: ServerResponse) => void;
export type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => void;

export interface UpstreamHit {
  path: string;
  query: Record<string, string>;
  headers: IncomingHttpHeaders;
}

export interface FakeUpstream {
  url: string;
  hits: UpstreamHit[];
  hitsFor(path: string): UpstreamHit[];
  set(path: string, handler: Handler): void;
  close(): Promise<void>;
}

/**
 * A tiny stand-in for google.com / news.google.com. `routes` maps "/path" to
 * (req, res, url) => void. /robots.txt allows everything unless overridden.
 */
export async function startFakeUpstream(routes: Record<string, Handler> = {}): Promise<FakeUpstream> {
  const hits: UpstreamHit[] = [];
  const table = new Map<string, Handler>(Object.entries({ '/robots.txt': ((_req, res) => void res.end('User-agent: *\nAllow: /\n')) as Handler, ...routes }));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    hits.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers });
    const handler = table.get(url.pathname);
    if (!handler) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    handler(req, res, url);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake upstream failed to bind');
  return {
    url: `http://127.0.0.1:${address.port}`,
    hits,
    hitsFor: (p) => hits.filter((h) => h.path === p),
    set: (p, handler) => void table.set(p, handler),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

export const html =
  (body: string): Responder =>
  (_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(body);
  };

export const xml =
  (body: string): Responder =>
  (_req, res) => {
    res.setHeader('content-type', 'application/rss+xml; charset=utf-8');
    res.end(body);
  };
