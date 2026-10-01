import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
export const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/**
 * A tiny stand-in for google.com / news.google.com. `routes` maps "/path" to
 * (req, res, url) => void. /robots.txt allows everything unless overridden.
 */
export async function startFakeUpstream(routes = {}) {
  const hits = [];
  const table = new Map(Object.entries({ '/robots.txt': (req, res) => res.end('User-agent: *\nAllow: /\n'), ...routes }));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    hits.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers });
    const handler = table.get(url.pathname);
    if (!handler) {
      res.statusCode = 404;
      return res.end('not found');
    }
    return handler(req, res, url);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    hitsFor: (p) => hits.filter((h) => h.path === p),
    set: (p, handler) => table.set(p, handler),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

export const html = (body) => (req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(body);
};
export const xml = (body) => (req, res) => {
  res.setHeader('content-type', 'application/rss+xml; charset=utf-8');
  res.end(body);
};
