/**
 * Capture live Google SERP pages as parser fixtures.
 *
 * Reuses the full production stack (createApp -> service.search) so captures go through
 * the same stealth, consent cookie, block guards, rate limiter and settings the server
 * uses. Output: test/fixtures/live/<name>.html + the parsed <name>.json + manifest.json.
 *
 * Run: npm run capture            (needs outbound access; residential IP recommended)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';

const OUT = path.resolve('test/fixtures/live');

// One page per parser surface that was previously fixture-verified with synthetic HTML only.
const TARGETS = [
  { name: 'web-coffee', params: { engine: 'google', q: 'coffee' } },
  { name: 'web-espresso-info', params: { engine: 'google', q: 'what is espresso' } },
  { name: 'web-ads', params: { engine: 'google', q: 'buy espresso machine online' } },
  { name: 'shopping', params: { engine: 'google', tbm: 'shop', q: 'espresso machine' } },
  { name: 'images', params: { engine: 'google', tbm: 'isch', q: 'coffee cup' } },
  { name: 'news-tab', params: { engine: 'google', tbm: 'nws', q: 'coffee' } },
];

// Optional filter: `npm run capture -- --only images news-tab` captures just those targets.
const only = process.argv.slice(2).filter((a) => a !== '--only');
const targets = only.length ? TARGETS.filter((t) => only.includes(t.name)) : TARGETS;
if (only.length && targets.length !== only.length) {
  console.error(`Unknown target(s): ${only.filter((n) => !TARGETS.some((t) => t.name === n)).join(', ')}. Known: ${TARGETS.map((t) => t.name).join(', ')}`);
  process.exit(2);
}

const { components, close } = createApp();
mkdirSync(OUT, { recursive: true });

const manifest = {
  capturedAt: new Date().toISOString(),
  mode: components.settings.get('headless') ? 'headless' : 'http',
  robotsPolicy: components.settings.get('robotsPolicy'),
  items: [],
};
console.log(`capturing ${targets.length} pages (mode=${manifest.mode}, minInterval=${components.settings.get('minIntervalMs')}ms)\n`);

for (const t of targets) {
  try {
    const r = await components.service.search({ ...t.params, no_cache: 'true' }, { baseUrl: 'http://127.0.0.1:3001' });
    writeFileSync(path.join(OUT, `${t.name}.html`), r.html);
    writeFileSync(path.join(OUT, `${t.name}.json`), JSON.stringify(r.body, null, 2));
    manifest.items.push({ name: t.name, status: 'ok', bytes: r.html.length, mode: r.mode, params: t.params });
    console.log(`ok   ${t.name.padEnd(18)} ${String(r.html.length).padStart(9)} bytes  mode=${r.mode}`);
  } catch (err) {
    manifest.items.push({ name: t.name, status: 'failed', code: err.code ?? 'UNKNOWN', message: err.message, params: t.params });
    console.error(`FAIL ${t.name.padEnd(18)} ${err.code ?? 'UNKNOWN'}: ${err.message}`);
    if (err.code === 'UPSTREAM_BLOCKED') {
      console.error('     -> Google served a CAPTCHA/block page. Captures need a residential IP or PROXY_URL;');
      console.error('        see .env.example. Remaining targets on this host will likely fail the same way.');
    }
  }
}

writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
await close();

const ok = manifest.items.filter((i) => i.status === 'ok').length;
console.log(`\n${ok}/${targets.length} captured -> ${OUT}`);
process.exit(ok === targets.length ? 0 : 1);
