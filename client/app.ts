// Web UI for SERP Alter Ego. Compiled to public/app.js by `npm run build:client`; no bundler.
// All scraped content is rendered with textContent / setAttribute only (never innerHTML).

// ---------- response shapes the UI reads (a loose mirror of the server's JSON) ----------
interface Settings {
  headless: boolean;
  fallbackToHeadless: boolean;
  robotsPolicy: 'enforce' | 'warn' | 'off';
  minIntervalMs: number;
  cacheTtlSeconds: number;
}
interface Status {
  settings: Settings;
  browser?: { running: boolean };
  limiter?: { hosts: Record<string, { blockedForSeconds: number }> };
}
interface HistoryEntry {
  ok: boolean;
  mode?: string;
  code?: string;
  status: number;
  engine: string;
  q?: string;
  ms: number;
  error?: string;
}
interface PriceMovement {
  percentage: number;
  value: number;
  movement: 'Up' | 'Down';
}
interface StockEntry {
  stock?: string;
  name: string;
  price: string;
  price_movement: PriceMovement;
}
interface NewsItem {
  title: string;
  link: string;
  thumbnail?: string;
  snippet?: string;
  date?: string;
  source?: string | { name?: string };
  stories?: Array<{ title: string; link: string }>;
}
interface Organic {
  position: number;
  title: string;
  link: string;
  displayed_link?: string;
  favicon?: string;
  date?: string;
  snippet?: string;
  source?: string;
}
interface Product {
  title: string;
  link?: string;
  product_link?: string;
  thumbnail?: string;
  price?: string;
  old_price?: string;
  source?: string;
  rating?: number;
  reviews?: number;
  delivery?: string;
  tag?: string;
}
interface ImageItem {
  title?: string;
  source?: string;
  link?: string;
  thumbnail?: string;
  original?: string;
  original_width?: number;
  original_height?: number;
}
interface WebKnowledgeGraph {
  title?: string;
  type?: string;
  description?: string;
  source?: { name: string; link?: string };
  website?: string;
  [attribute: string]: unknown;
}
interface FinanceSummary {
  title?: string;
  stock?: string;
  exchange?: string;
  price?: string;
  date?: string;
  price_movement?: PriceMovement;
  market?: { trading: string; price: string; price_movement?: PriceMovement };
}
interface FinanceKnowledgeGraph {
  key_stats?: { stats?: Array<{ label: string; description?: string; value: string }> };
  about?: { description?: { snippet?: string }; info?: Array<{ label: string; value: string }> };
}
interface SerpBody {
  search_metadata?: { raw_html_file?: string; google_url?: string; robots_txt?: string; scraper_fallback?: boolean };
  search_parameters?: { window?: string };
  error?: string;
  error_code?: string;
  search_information?: { total_results?: number; time_taken_displayed?: number };
  ads?: Array<{ title: string; link: string; displayed_link?: string; snippet?: string }>;
  answer_box?: { snippet?: string; title?: string; link?: string };
  organic_results?: Organic[];
  /** A web search returns a knowledge panel; a finance search returns key stats + about. */
  knowledge_graph?: WebKnowledgeGraph & FinanceKnowledgeGraph;
  related_questions?: Array<{ question: string; snippet?: string; title?: string; link?: string }>;
  related_searches?: Array<{ query: string }>;
  serpapi_pagination?: { next_link?: string };
  news_results?: NewsItem[];
  shopping_results?: Product[];
  images_results?: ImageItem[];
  suggested_searches?: Array<{ name: string; q?: string }>;
  summary?: FinanceSummary;
  graph?: Array<{ price?: number; date?: string }>;
  markets?: Record<string, StockEntry[]>;
  discover_more?: Array<{ title: string; items: StockEntry[] }>;
}

// ---------- engine form definitions ----------
type FieldType = 'number' | 'text' | 'select';
interface FieldOptions {
  min?: number;
  max?: number;
  maxlength?: number;
  placeholder?: string;
  wide?: boolean;
  options?: string[];
}
type FieldSpec = [name: string, label: string, type: FieldType, options?: FieldOptions];
interface EngineSpec {
  label: string;
  q: string;
  qLabel: string;
  examples?: string[];
  fields: FieldSpec[];
}

const hlField: FieldSpec = ['hl', 'Language (hl)', 'text', { placeholder: 'en' }];
const glField: FieldSpec = ['gl', 'Country (gl)', 'text', { placeholder: 'us', maxlength: 2 }];
const domainField: FieldSpec = ['google_domain', 'Google domain', 'text', { placeholder: 'google.com' }];
const locationField: FieldSpec = ['location', 'Location', 'text', { placeholder: 'Austin, Texas, United States', wide: true }];
const safeField: FieldSpec = ['safe', 'SafeSearch', 'select', { options: ['', 'active', 'off'] }];
const numAllField: FieldSpec = ['num', 'Results (num)', 'number', { min: 1, max: 100, placeholder: 'all' }];

const ENGINES: Record<string, EngineSpec> = {
  google: {
    label: 'Web',
    q: 'coffee',
    qLabel: 'Query',
    fields: [
      ['num', 'Results (num)', 'number', { min: 1, max: 100, placeholder: '10' }],
      ['start', 'Offset (start)', 'number', { min: 0, placeholder: '0' }],
      hlField,
      glField,
      locationField,
      domainField,
      safeField,
      ['tbm', 'Tab (tbm)', 'select', { options: ['', 'nws', 'shop', 'isch'] }],
    ],
  },
  google_news: { label: 'News', q: 'coffee', qLabel: 'Query', fields: [numAllField, hlField, glField, ['topic_token', 'Topic token', 'text', { placeholder: 'optional' }]] },
  google_shopping: { label: 'Shopping', q: 'espresso machine', qLabel: 'Query', fields: [numAllField, hlField, glField, domainField, locationField] },
  google_images: { label: 'Images', q: 'coffee', qLabel: 'Query', fields: [numAllField, ['ijn', 'Page (ijn)', 'number', { min: 0, placeholder: '0' }], hlField, glField, domainField, safeField] },
  google_finance: {
    label: 'Finance',
    q: 'GOOGL:NASDAQ',
    qLabel: 'Ticker (TICKER:EXCHANGE)',
    examples: ['GOOGL:NASDAQ', 'AAPL:NASDAQ', '.INX:INDEXSP', 'EUR-USD', 'BTC-USD'],
    fields: [['window', 'Chart window', 'select', { options: ['', '1D', '5D', '1M', '6M', 'YTD', '1Y', '5Y', 'MAX'] }], hlField],
  },
};

interface State {
  engine: string;
  status: Status | null;
  settings: Settings | null;
  lastBody: SerpBody | null;
  view: 'visual' | 'json';
}
const state: State = { engine: 'google', status: null, settings: null, lastBody: null, view: 'visual' };

// ---------- tiny DOM helpers ----------
/** Look up an element that must exist in index.html. */
function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`index.html is missing #${id}`);
  return el as T;
}

type Child = Node | string | number | false | null | undefined | Child[];
type PropValue = string | number | boolean | null | undefined | ((event: Event) => unknown);

function appendChild(el: Element, child: Child): void {
  if (Array.isArray(child)) child.forEach((c) => appendChild(el, c));
  else if (child instanceof Node) el.append(child);
  else if (child !== undefined && child !== null && child !== false) el.append(document.createTextNode(String(child)));
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, PropValue> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else if (typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  children.forEach((c) => appendChild(el, c));
  return el;
}

const clear = (el: Element): void => el.replaceChildren();
const safeHref = (u: unknown): string | null => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
const safeImg = (u: unknown): string | null => (typeof u === 'string' && /^(https?:\/\/|data:image\/)/i.test(u) ? u : null);

function link(text: string, href: unknown, cls?: string): HTMLElement {
  const url = safeHref(href);
  return url ? h('a', { href: url, target: '_blank', rel: 'noreferrer noopener', class: cls, text }) : h('span', { class: cls, text });
}
function img(src: unknown, alt = ''): HTMLImageElement | null {
  const s = safeImg(src);
  return s ? h('img', { src: s, alt, loading: 'lazy', referrerpolicy: 'no-referrer' }) : null;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(message: string): void {
  const t = $('toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

interface ApiResult<T> {
  ok: boolean;
  status: number;
  body: T;
}
async function api<T = Record<string, unknown>>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  const res = await fetch(path, init);
  const body = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, body };
}
const patchSettings = (patch: Partial<Settings>): Promise<ApiResult<Settings & { error?: string }>> =>
  api('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });

// ---------- engine tabs + form ----------
function renderTabs(): void {
  const tabs = $('engine-tabs');
  clear(tabs);
  for (const [id, spec] of Object.entries(ENGINES)) {
    tabs.append(
      h('button', {
        class: `tab${id === state.engine ? ' active' : ''}`,
        type: 'button',
        role: 'tab',
        'aria-selected': String(id === state.engine),
        text: spec.label,
        onclick: () => selectEngine(id),
      }),
    );
  }
}

const queryInput = (): HTMLInputElement => $<HTMLInputElement>('f-q');
const fieldControl = (name: string): HTMLInputElement | HTMLSelectElement | null =>
  document.getElementById(`f-${name}`) as HTMLInputElement | HTMLSelectElement | null;

function selectEngine(id: string, keepQuery = false): void {
  state.engine = id;
  const spec = ENGINES[id] as EngineSpec;
  renderTabs();
  $('q-label').textContent = spec.qLabel;
  queryInput().placeholder = spec.q;
  if (!keepQuery) queryInput().value = spec.q;
  const ex = $('q-examples');
  clear(ex);
  ex.hidden = !spec.examples;
  for (const e of spec.examples ?? []) {
    ex.append(h('button', { class: 'chip', type: 'button', text: e, onclick: () => { queryInput().value = e; updateCurl(); } }));
  }

  const box = $('extra-fields');
  clear(box);
  for (const [name, label, type, opts = {}] of spec.fields) {
    const control =
      type === 'select'
        ? h('select', { id: `f-${name}`, name }, (opts.options ?? []).map((o) => h('option', { value: o, text: o || '(default)' })))
        : h('input', { id: `f-${name}`, name, type, min: opts.min, max: opts.max, maxlength: opts.maxlength, placeholder: opts.placeholder });
    box.append(h('label', { class: `field${opts.wide ? ' span-2' : ''}` }, h('span', { text: label }), control));
  }
  updateCurl();
}

function currentParams(): Record<string, string> {
  const params: Record<string, string> = { engine: state.engine, q: queryInput().value.trim() };
  for (const [name] of (ENGINES[state.engine] as EngineSpec).fields) {
    const v = fieldControl(name)?.value.trim();
    if (v) params[name] = v;
  }
  if ($<HTMLInputElement>('f-no-cache').checked) params.no_cache = 'true';
  const mode = $<HTMLSelectElement>('f-mode').value;
  if (mode) params.headless = mode;
  return params;
}

function updateCurl(): void {
  const lines = Object.entries(currentParams()).map(([k, v]) => `  --data-urlencode "${k}=${v.replaceAll('"', '\\"')}"`);
  $('curl').textContent = `curl -G "${location.origin}/search.json" \\\n${lines.join(' \\\n')}`;
}

// ---------- running a search ----------
interface ResultView {
  status: number;
  body: SerpBody;
  ms: number;
  mode?: string | null;
  cache?: string | null;
}

async function runSearch(evt?: Event): Promise<void> {
  evt?.preventDefault();
  const params = currentParams();
  if (!params.q) return;
  const btn = $<HTMLButtonElement>('submit');
  btn.disabled = true;
  btn.textContent = 'Searching…';
  const started = performance.now();
  try {
    const res = await fetch(`/search.json?${new URLSearchParams(params)}`);
    const body = (await res.json().catch(() => ({ error: `Unexpected response (HTTP ${res.status})` }))) as SerpBody;
    showResult({ status: res.status, body, ms: performance.now() - started, mode: res.headers.get('x-scraper-mode'), cache: res.headers.get('x-cache') });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showResult({ status: 0, body: { error: `Could not reach the service: ${message}`, error_code: 'NETWORK' }, ms: performance.now() - started });
  } finally {
    btn.disabled = false;
    btn.textContent = 'Search';
    void refreshHistory();
    void refreshStatus();
  }
}

function showResult({ status, body, ms, mode, cache }: ResultView): void {
  state.lastBody = body;
  $('result-empty').hidden = true;
  $('result').hidden = false;

  const meta = $('meta');
  clear(meta);
  const item = (k: string, v: string): void => void meta.append(h('span', { class: 'item' }, `${k} `, h('b', { text: v })));
  item('HTTP', String(status || 'n/a'));
  if (mode) item('mode', mode + (body.search_metadata?.scraper_fallback ? ' (fallback)' : ''));
  if (cache) item('cache', cache);
  item('time', `${(ms / 1000).toFixed(2)}s`);
  if (body.search_metadata?.robots_txt) item('robots.txt', body.search_metadata.robots_txt);
  if (body.search_metadata?.google_url) meta.append(link('Open on Google ↗', body.search_metadata.google_url, 'item'));

  const err = $('error');
  clear(err);
  err.hidden = !body.error;
  if (body.error) {
    err.append(h('span', { class: 'code-tag', text: body.error_code || (status === 200 ? 'NO_RESULTS' : `HTTP ${status}`) }), body.error);
    const actions = h('div', { class: 'actions' });
    if (body.error_code === 'JS_REQUIRED') {
      actions.append(h('button', { class: 'btn small', type: 'button', text: 'Turn headless ON and retry', onclick: async () => { await setHeadless(true); await runSearch(); } }));
    }
    if (body.error_code === 'ROBOTS_DISALLOWED' || body.error_code === 'ROBOTS_UNAVAILABLE') {
      actions.append(h('button', { class: 'btn small', type: 'button', text: 'Open settings', onclick: openSettings }));
    }
    if (actions.children.length) err.append(actions);
  }

  const raw = $<HTMLAnchorElement>('raw-link');
  const rawHref = safeHref(body.search_metadata?.raw_html_file);
  raw.hidden = !rawHref;
  if (rawHref) raw.href = new URL(rawHref).pathname;

  $('json').textContent = JSON.stringify(body, null, 2);
  renderVisual(body);
}

// ---------- visual renderers ----------
const section = (title: string | null, ...children: Child[]): HTMLElement => h('div', { class: 'section' }, title && h('h3', { text: title }), ...children);
const searchChip = (text: string): HTMLElement =>
  h('button', { class: 'chip', type: 'button', text, onclick: () => { queryInput().value = text; void runSearch(); } });

function renderVisual(body: SerpBody): void {
  const v = $('visual');
  clear(v);
  const isFinance = Boolean(body.summary);
  if (!isFinance && (body.organic_results || body.knowledge_graph || body.related_searches)) renderWeb(v, body);
  if (body.news_results && !isFinance) renderNews(v, body.news_results);
  if (body.shopping_results) renderShopping(v, body.shopping_results);
  if (body.images_results) renderImages(v, body);
  if (isFinance) renderFinance(v, body);
  if (!v.children.length && !body.error) v.append(h('p', { class: 'muted', text: 'No visual representation for this response; see the JSON tab.' }));
}

function renderWeb(v: HTMLElement, body: SerpBody): void {
  const info = body.search_information;
  if (info?.total_results) {
    v.append(h('p', { class: 'muted', text: `About ${info.total_results.toLocaleString()} results${info.time_taken_displayed ? ` (${info.time_taken_displayed}s)` : ''}` }));
  }

  if (body.ads?.length) {
    v.append(section('Ads', h('div', { class: 'cards' }, body.ads.map((a) => h('div', { class: 'result-card' }, link(a.title, a.link, 'link-title'), h('div', { class: 'crumb', text: a.displayed_link || '' }), h('div', { class: 'snippet', text: a.snippet || '' }))))));
  }
  if (body.answer_box?.snippet) {
    const box = body.answer_box;
    v.append(section('Featured snippet', h('div', { class: 'qa' }, box.snippet, box.link ? h('div', {}, link(box.title || box.link, box.link)) : null)));
  }

  const organic = (body.organic_results ?? []).map((r) =>
    h('div', { class: 'result-card' },
      h('div', { class: 'crumb' }, img(r.favicon), r.source ? `${r.source} · ` : '', r.displayed_link || ''),
      h('div', {}, h('span', { class: 'pos', text: `#${r.position}` }), link(r.title, r.link, 'link-title')),
      r.snippet ? h('div', { class: 'snippet', text: (r.date ? `${r.date} — ` : '') + r.snippet }) : null),
  );
  const main = section(`Organic results (${organic.length})`, h('div', { class: 'cards' }, organic));

  const kg = body.knowledge_graph;
  if (kg) {
    const dl = h('dl');
    for (const [k, val] of Object.entries(kg)) {
      if (['title', 'type', 'description', 'source', 'website'].includes(k) || typeof val !== 'string') continue;
      dl.append(h('dt', { text: k.replaceAll('_', ' ') }), h('dd', { text: val }));
    }
    const side = h('aside', { class: 'kg' },
      h('h4', { text: kg.title || '' }),
      h('div', { class: 'type', text: kg.type || '' }),
      kg.description ? h('p', { text: kg.description }) : null,
      kg.source ? link(kg.source.name, kg.source.link) : null,
      dl,
      kg.website ? h('div', {}, link('Website', kg.website)) : null);
    v.append(h('div', { class: 'split' }, main, side));
  } else {
    v.append(main);
  }

  if (body.related_questions?.length) {
    v.append(section('People also ask', body.related_questions.map((q) => h('div', { class: 'qa' }, h('b', { text: q.question }), q.snippet || '', q.link ? h('div', {}, link(q.title || q.link, q.link)) : null))));
  }
  if (body.related_searches?.length) v.append(section('Related searches', h('div', { class: 'pillrow' }, body.related_searches.map((r) => searchChip(r.query)))));
  const next = body.serpapi_pagination?.next_link;
  if (next && !body.error) {
    v.append(h('div', {}, h('button', { class: 'btn small', type: 'button', text: 'Next page →', onclick: () => { setField('start', new URL(next).searchParams.get('start')); void runSearch(); } })));
  }
}

function setField(name: string, value: string | null): void {
  const el = fieldControl(name);
  if (el && value != null) el.value = value;
  updateCurl();
}

function renderNews(v: HTMLElement, items: NewsItem[]): void {
  v.append(section(`News results (${items.length})`, h('div', { class: 'cards' }, items.map((n) => {
    const sourceName = typeof n.source === 'string' ? n.source : n.source?.name;
    return h('div', { class: 'result-card news-item' },
      img(n.thumbnail),
      h('div', {},
        link(n.title, n.link, 'link-title'),
        h('div', { class: 'crumb', text: [sourceName, n.date].filter(Boolean).join(' · ') }),
        n.snippet && n.snippet !== n.title ? h('div', { class: 'snippet', text: n.snippet }) : null,
        n.stories?.length ? h('div', { class: 'snippet' }, `${n.stories.length} related: `, n.stories.slice(0, 3).map((s, i) => [i ? ' · ' : '', link(s.title, s.link)])) : null));
  }))));
}

function renderShopping(v: HTMLElement, items: Product[]): void {
  v.append(section(`Shopping results (${items.length})`, h('div', { class: 'grid-cards' }, items.map((p) =>
    h('div', { class: 'tile' },
      img(p.thumbnail, p.title),
      link(p.title, p.link || p.product_link, 't'),
      h('div', { class: 'price' }, p.price || '', p.old_price ? h('span', { class: 'old', text: p.old_price }) : null),
      h('div', { class: 'small', text: [p.source, p.rating ? `★ ${p.rating}${p.reviews ? ` (${p.reviews.toLocaleString()})` : ''}` : null].filter(Boolean).join(' · ') }),
      p.delivery ? h('div', { class: 'small', text: p.delivery }) : null,
      p.tag ? h('span', { class: 'badge', text: p.tag }) : null)))));
}

function renderImages(v: HTMLElement, body: SerpBody): void {
  const items = body.images_results ?? [];
  v.append(section(`Image results (${items.length})`, h('div', { class: 'grid-cards' }, items.map((i) =>
    h('div', { class: 'tile image' },
      img(i.thumbnail || i.original, i.title || ''),
      link(i.title || i.source || 'Image', i.link, 't'),
      h('div', { class: 'small', text: [i.source, i.original_width && `${i.original_width}×${i.original_height}`].filter(Boolean).join(' · ') }),
      i.original ? link('Original ↗', i.original, 'small') : null)))));
  if (body.suggested_searches?.length) v.append(section('Suggested searches', h('div', { class: 'pillrow' }, body.suggested_searches.map((s) => searchChip(s.q || s.name)))));
}

function sparkline(points: NonNullable<SerpBody['graph']>): SVGSVGElement | null {
  const prices = points.map((p) => p.price).filter((n): n is number => typeof n === 'number');
  if (prices.length < 2) return null;
  const W = 560, H = 120, pad = 6;
  const min = Math.min(...prices), max = Math.max(...prices), span = max - min || 1;
  const x = (i: number): number => pad + (i * (W - pad * 2)) / (prices.length - 1);
  const y = (p: number): number => H - pad - ((p - min) * (H - pad * 2)) / span;
  const d = prices.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p).toFixed(1)}`).join(' ');
  const color = (prices.at(-1) ?? 0) >= (prices[0] ?? 0) ? 'var(--good)' : 'var(--bad)';
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'sparkline');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Price from ${points[0]?.date} to ${points.at(-1)?.date}`);
  const area = document.createElementNS(ns, 'path');
  area.setAttribute('class', 'area');
  area.setAttribute('d', `${d} L${x(prices.length - 1).toFixed(1)},${H} L${x(0).toFixed(1)},${H} Z`);
  area.setAttribute('fill', color);
  const line = document.createElementNS(ns, 'path');
  line.setAttribute('class', 'line');
  line.setAttribute('d', d);
  line.setAttribute('stroke', color);
  svg.append(area, line);
  return svg;
}

function renderFinance(v: HTMLElement, body: SerpBody): void {
  const s = body.summary;
  if (!s) return;
  const pm = s.price_movement;
  const dir = pm?.movement === 'Down' ? 'down' : 'up';
  const market = s.market;
  v.append(h('div', { class: 'section' },
    h('div', { class: 'quote' },
      h('div', {}, h('div', { class: 'name', text: `${s.title || ''} ${s.stock ? `· ${s.stock}${s.exchange ? `:${s.exchange}` : ''}` : ''}` }), h('div', { class: 'price', text: s.price || '' })),
      pm ? h('div', { class: dir, text: `${dir === 'down' ? '▼' : '▲'} ${pm.value} (${pm.percentage}%)` }) : null),
    h('div', { class: 'muted', text: s.date || '' }),
    market ? h('div', { class: 'muted', text: `${market.trading}: ${market.price} (${market.price_movement?.movement === 'Down' ? '-' : '+'}${market.price_movement?.percentage}%)` }) : null));

  const chart = body.graph?.length ? sparkline(body.graph) : null;
  if (chart) v.append(section(`Chart (${body.graph?.length} points, ${body.search_parameters?.window || '1D'})`, chart));

  const stats = body.knowledge_graph?.key_stats?.stats;
  if (stats?.length) v.append(section('Key stats', h('div', { class: 'stats' }, stats.map((st) => h('div', { title: st.description }, h('span', { text: st.label }), h('span', { text: st.value }))))));
  const about = body.knowledge_graph?.about;
  if (about) {
    const snippet = about.description?.snippet || '';
    v.append(section('About',
      snippet ? h('p', { class: 'snippet', text: snippet.slice(0, 600) + (snippet.length > 600 ? '…' : '') }) : null,
      h('div', { class: 'stats' }, (about.info ?? []).map((i) => h('div', {}, h('span', { text: i.label }), h('span', { text: i.value }))))));
  }
  if (body.news_results?.length) renderNews(v, body.news_results.slice(0, 8));
  const discover = body.discover_more?.[0];
  if (discover?.items.length) {
    v.append(section(discover.title, h('div', { class: 'pillrow' }, discover.items.map((i) => h('button', { class: 'chip', type: 'button', text: `${i.stock} ${i.price || ''}`, onclick: () => { queryInput().value = i.stock ?? ''; void runSearch(); } })))));
  }
  if (body.markets) {
    for (const [group, entries] of Object.entries(body.markets)) {
      v.append(section(`Markets: ${group}`, h('div', { class: 'stats' }, entries.map((e) => h('div', {}, h('span', { text: e.name }), h('span', { class: e.price_movement.movement === 'Down' ? 'down' : 'up', text: `${e.price} ${e.price_movement.movement === 'Down' ? '▼' : '▲'}${e.price_movement.percentage}%` }))))));
    }
  }
}

// ---------- views ----------
function setView(view: State['view']): void {
  state.view = view;
  $('view-visual').classList.toggle('active', view === 'visual');
  $('view-json').classList.toggle('active', view === 'json');
  $('view-visual').setAttribute('aria-selected', String(view === 'visual'));
  $('view-json').setAttribute('aria-selected', String(view === 'json'));
  $('visual').hidden = view !== 'visual';
  $('json').hidden = view !== 'json';
}

// ---------- status, settings, history ----------
async function refreshStatus(): Promise<void> {
  const res = await api<Status>('/api/status').catch(() => null);
  if (!res?.ok) return;
  state.status = res.body;
  state.settings = res.body.settings;
  paintSettings();
  const blocked = Object.entries(res.body.limiter?.hosts ?? {}).filter(([, s]) => s.blockedForSeconds > 0);
  const notice = $('notice');
  if (blocked.length) {
    notice.hidden = false;
    notice.textContent = `${blocked.map(([host]) => host).join(', ')} blocked this machine (CAPTCHA / HTTP 429). Requests are paused for ${Math.max(...blocked.map(([, s]) => s.blockedForSeconds))}s.`;
  } else {
    notice.hidden = true;
  }
}

function paintSettings(): void {
  const s = state.settings;
  if (!s) return;
  const pill = $('mode-pill');
  pill.textContent = s.headless ? 'HEADLESS' : 'HTTP';
  pill.className = `pill${s.headless ? ' headless' : ''}`;
  const browser = state.status?.browser;
  pill.title = s.headless ? `Headless browser mode${browser?.running ? ' (browser running)' : ' (browser starts on first search)'}` : 'Lightweight HTTP mode';
  $<HTMLInputElement>('headless-toggle').checked = s.headless;
}

async function setHeadless(on: boolean): Promise<void> {
  const toggle = $<HTMLInputElement>('headless-toggle');
  toggle.disabled = true;
  const res = await patchSettings({ headless: on });
  toggle.disabled = false;
  if (res.ok) {
    state.settings = res.body;
    paintSettings();
    toast(on ? 'Headless mode ON: pages are rendered in Chrome' : 'Headless mode OFF: plain HTTP requests');
    void refreshStatus();
  } else {
    toggle.checked = !on;
    toast(res.body.error || 'Could not change the mode');
  }
}

function openSettings(): void {
  const s = state.settings;
  $<HTMLInputElement>('s-headless').checked = Boolean(s?.headless);
  $<HTMLInputElement>('s-fallback').checked = Boolean(s?.fallbackToHeadless);
  $<HTMLSelectElement>('s-robots').value = s?.robotsPolicy || 'enforce';
  $<HTMLInputElement>('s-interval').value = String(s?.minIntervalMs ?? '');
  $<HTMLInputElement>('s-cache').value = String(s?.cacheTtlSeconds ?? '');
  $('settings-error').hidden = true;
  $('robots-warning').hidden = $<HTMLSelectElement>('s-robots').value === 'enforce';
  $<HTMLDialogElement>('settings-dialog').showModal();
}

async function saveSettings(evt: Event): Promise<void> {
  evt.preventDefault();
  const res = await patchSettings({
    headless: $<HTMLInputElement>('s-headless').checked,
    fallbackToHeadless: $<HTMLInputElement>('s-fallback').checked,
    robotsPolicy: $<HTMLSelectElement>('s-robots').value as Settings['robotsPolicy'],
    minIntervalMs: Number($<HTMLInputElement>('s-interval').value),
    cacheTtlSeconds: Number($<HTMLInputElement>('s-cache').value),
  });
  if (!res.ok) {
    $('settings-error').textContent = res.body.error || 'Invalid settings';
    $('settings-error').hidden = false;
    return;
  }
  state.settings = res.body;
  paintSettings();
  $<HTMLDialogElement>('settings-dialog').close();
  toast('Settings saved');
  void refreshStatus();
}

async function refreshHistory(): Promise<void> {
  const res = await api<{ history: HistoryEntry[] }>('/api/history').catch(() => null);
  if (!res?.ok) return;
  const list = $('history');
  clear(list);
  if (!res.body.history.length) list.append(h('li', { class: 'muted', text: 'Nothing yet.' }));
  for (const e of res.body.history.slice(0, 25)) {
    list.append(h('li', {}, h('button', {
      type: 'button',
      title: e.error || `${e.engine} · ${e.ms} ms`,
      onclick: () => { if (ENGINES[e.engine]) { selectEngine(e.engine, true); queryInput().value = e.q || ''; updateCurl(); } },
    },
      h('span', { class: `badge ${e.ok ? 'ok' : 'bad'}`, text: e.ok ? (e.mode || 'ok') : (e.code || String(e.status)) }),
      h('span', { class: 'history-q', text: `${ENGINES[e.engine]?.label || e.engine}: ${e.q || ''}` }),
      h('span', { class: 'history-ms', text: `${(e.ms / 1000).toFixed(1)}s` }))));
  }
}

// ---------- wire up ----------
const copy = (text: string, done: string): void => void navigator.clipboard?.writeText(text).then(() => toast(done));

$('search-form').addEventListener('submit', runSearch);
$('search-form').addEventListener('input', updateCurl);
$('f-mode').addEventListener('change', updateCurl);
$('headless-toggle').addEventListener('change', (e) => void setHeadless((e.target as HTMLInputElement).checked));
$('open-settings').addEventListener('click', openSettings);
$('settings-form').addEventListener('submit', saveSettings);
$('settings-cancel').addEventListener('click', () => $<HTMLDialogElement>('settings-dialog').close());
$('s-robots').addEventListener('change', () => ($('robots-warning').hidden = $<HTMLSelectElement>('s-robots').value === 'enforce'));
$('settings-reset').addEventListener('click', async () => {
  const res = await api<Settings>('/api/settings', { method: 'DELETE' });
  if (res.ok) {
    state.settings = res.body;
    paintSettings();
    $<HTMLDialogElement>('settings-dialog').close();
    toast('Reset to environment defaults');
    void refreshStatus();
  }
});
$('view-visual').addEventListener('click', () => setView('visual'));
$('view-json').addEventListener('click', () => setView('json'));
$('refresh-history').addEventListener('click', () => void refreshHistory());
$('copy-curl').addEventListener('click', () => copy($('curl').textContent ?? '', 'curl command copied'));
$('copy-json').addEventListener('click', () => copy($('json').textContent ?? '', 'JSON copied'));

selectEngine('google');
void refreshStatus();
void refreshHistory();
setInterval(() => void refreshStatus(), 5000);
