// Web UI for SERP Alter Ego. Plain ES module, no build step.
// All scraped content is rendered with textContent / setAttribute only (never innerHTML).

const $ = (id) => document.getElementById(id);

const ENGINES = {
  google: {
    label: 'Web',
    q: 'coffee',
    qLabel: 'Query',
    fields: [
      ['num', 'Results (num)', 'number', { min: 1, max: 100, placeholder: '10' }],
      ['start', 'Offset (start)', 'number', { min: 0, placeholder: '0' }],
      ['hl', 'Language (hl)', 'text', { placeholder: 'en' }],
      ['gl', 'Country (gl)', 'text', { placeholder: 'us', maxlength: 2 }],
      ['location', 'Location', 'text', { placeholder: 'Austin, Texas, United States', wide: true }],
      ['google_domain', 'Google domain', 'text', { placeholder: 'google.com' }],
      ['safe', 'SafeSearch', 'select', { options: ['', 'active', 'off'] }],
      ['tbm', 'Tab (tbm)', 'select', { options: ['', 'nws', 'shop', 'isch'] }],
    ],
  },
  google_news: {
    label: 'News',
    q: 'coffee',
    qLabel: 'Query',
    fields: [
      ['num', 'Results (num)', 'number', { min: 1, max: 100, placeholder: 'all' }],
      ['hl', 'Language (hl)', 'text', { placeholder: 'en' }],
      ['gl', 'Country (gl)', 'text', { placeholder: 'us', maxlength: 2 }],
      ['topic_token', 'Topic token', 'text', { placeholder: 'optional' }],
    ],
  },
  google_shopping: {
    label: 'Shopping',
    q: 'espresso machine',
    qLabel: 'Query',
    fields: [
      ['num', 'Results (num)', 'number', { min: 1, max: 100, placeholder: 'all' }],
      ['hl', 'Language (hl)', 'text', { placeholder: 'en' }],
      ['gl', 'Country (gl)', 'text', { placeholder: 'us', maxlength: 2 }],
      ['google_domain', 'Google domain', 'text', { placeholder: 'google.com' }],
      ['location', 'Location', 'text', { placeholder: 'Austin, Texas, United States', wide: true }],
    ],
  },
  google_images: {
    label: 'Images',
    q: 'coffee',
    qLabel: 'Query',
    fields: [
      ['num', 'Results (num)', 'number', { min: 1, max: 100, placeholder: 'all' }],
      ['ijn', 'Page (ijn)', 'number', { min: 0, placeholder: '0' }],
      ['hl', 'Language (hl)', 'text', { placeholder: 'en' }],
      ['gl', 'Country (gl)', 'text', { placeholder: 'us', maxlength: 2 }],
      ['google_domain', 'Google domain', 'text', { placeholder: 'google.com' }],
      ['safe', 'SafeSearch', 'select', { options: ['', 'active', 'off'] }],
    ],
  },
  google_finance: {
    label: 'Finance',
    q: 'GOOGL:NASDAQ',
    qLabel: 'Ticker (TICKER:EXCHANGE)',
    examples: ['GOOGL:NASDAQ', 'AAPL:NASDAQ', '.INX:INDEXSP', 'EUR-USD', 'BTC-USD'],
    fields: [
      ['window', 'Chart window', 'select', { options: ['', '1D', '5D', '1M', '6M', 'YTD', '1Y', '5Y', 'MAX'] }],
      ['hl', 'Language (hl)', 'text', { placeholder: 'en' }],
    ],
  },
};

const state = { engine: 'google', status: null, settings: null, lastBody: null, view: 'visual' };

// ---------- tiny DOM helpers ----------
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c !== undefined && c !== null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const clear = (el) => el.replaceChildren();
const safeHref = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
const safeImg = (u) => (typeof u === 'string' && /^(https?:\/\/|data:image\/)/i.test(u) ? u : null);
function link(text, href, cls) {
  const url = safeHref(href);
  return url ? h('a', { href: url, target: '_blank', rel: 'noreferrer noopener', class: cls, text }) : h('span', { class: cls, text });
}
function img(src, alt = '') {
  const s = safeImg(src);
  return s ? h('img', { src: s, alt, loading: 'lazy', referrerpolicy: 'no-referrer' }) : null;
}
let toastTimer;
function toast(message) {
  const t = $('toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}
async function api(path, init) {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body, headers: res.headers };
}
const patchSettings = (patch) =>
  api('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });

// ---------- engine tabs + form ----------
function renderTabs() {
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

function selectEngine(id, keepQuery = false) {
  state.engine = id;
  const spec = ENGINES[id];
  renderTabs();
  $('q-label').textContent = spec.qLabel;
  $('f-q').placeholder = spec.q;
  if (!keepQuery) $('f-q').value = spec.q;
  const ex = $('q-examples');
  clear(ex);
  ex.hidden = !spec.examples;
  for (const e of spec.examples || []) ex.append(h('button', { class: 'chip', type: 'button', text: e, onclick: () => { $('f-q').value = e; updateCurl(); } }));

  const box = $('extra-fields');
  clear(box);
  for (const [name, label, type, opts = {}] of spec.fields) {
    const control =
      type === 'select'
        ? h('select', { id: `f-${name}`, name }, opts.options.map((o) => h('option', { value: o, text: o || '(default)' })))
        : h('input', { id: `f-${name}`, name, type, min: opts.min, max: opts.max, maxlength: opts.maxlength, placeholder: opts.placeholder });
    box.append(h('label', { class: `field${opts.wide ? ' span-2' : ''}` }, h('span', { text: label }), control));
  }
  updateCurl();
}

function currentParams() {
  const params = { engine: state.engine, q: $('f-q').value.trim() };
  for (const [name] of ENGINES[state.engine].fields) {
    const v = $(`f-${name}`)?.value?.trim();
    if (v) params[name] = v;
  }
  if ($('f-no-cache').checked) params.no_cache = 'true';
  if ($('f-mode').value) params.headless = $('f-mode').value;
  return params;
}

function updateCurl() {
  const lines = Object.entries(currentParams()).map(([k, v]) => `  --data-urlencode "${k}=${String(v).replaceAll('"', '\\"')}"`);
  $('curl').textContent = `curl -G "${location.origin}/search.json" \\\n${lines.join(' \\\n')}`;
}

// ---------- running a search ----------
async function runSearch(evt) {
  evt?.preventDefault();
  const params = currentParams();
  if (!params.q) return;
  const btn = $('submit');
  btn.disabled = true;
  btn.textContent = 'Searching…';
  const started = performance.now();
  try {
    const res = await fetch(`/search.json?${new URLSearchParams(params)}`);
    const body = await res.json().catch(() => ({ error: `Unexpected response (HTTP ${res.status})` }));
    showResult({ status: res.status, body, ms: performance.now() - started, mode: res.headers.get('x-scraper-mode'), cache: res.headers.get('x-cache') });
  } catch (err) {
    showResult({ status: 0, body: { error: `Could not reach the service: ${err.message}`, error_code: 'NETWORK' }, ms: performance.now() - started });
  } finally {
    btn.disabled = false;
    btn.textContent = 'Search';
    refreshHistory();
    refreshStatus();
  }
}

function showResult({ status, body, ms, mode, cache }) {
  state.lastBody = body;
  $('result-empty').hidden = true;
  $('result').hidden = false;

  const meta = $('meta');
  clear(meta);
  const item = (k, v) => meta.append(h('span', { class: 'item' }, `${k} `, h('b', { text: v })));
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
      actions.append(h('button', { class: 'btn small', type: 'button', text: 'Turn headless ON and retry', onclick: async () => { await setHeadless(true); runSearch(); } }));
    }
    if (body.error_code === 'ROBOTS_DISALLOWED' || body.error_code === 'ROBOTS_UNAVAILABLE') {
      actions.append(h('button', { class: 'btn small', type: 'button', text: 'Open settings', onclick: openSettings }));
    }
    if (actions.children.length) err.append(actions);
  }

  const raw = $('raw-link');
  const rawHref = safeHref(body.search_metadata?.raw_html_file);
  raw.hidden = !rawHref;
  if (rawHref) raw.href = new URL(rawHref).pathname;

  $('json').textContent = JSON.stringify(body, null, 2);
  renderVisual(body);
}

// ---------- visual renderers ----------
const section = (title, ...children) => h('div', { class: 'section' }, title && h('h3', { text: title }), ...children);
const searchChip = (text) => h('button', { class: 'chip', type: 'button', text, onclick: () => { $('f-q').value = text; runSearch(); } });

function renderVisual(body) {
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

function renderWeb(v, body) {
  const info = body.search_information;
  if (info?.total_results) v.append(h('p', { class: 'muted', text: `About ${info.total_results.toLocaleString()} results${info.time_taken_displayed ? ` (${info.time_taken_displayed}s)` : ''}` }));

  if (body.ads?.length) {
    v.append(section('Ads', h('div', { class: 'cards' }, body.ads.map((a) => h('div', { class: 'result-card' }, link(a.title, a.link, 'link-title'), h('div', { class: 'crumb', text: a.displayed_link || '' }), h('div', { class: 'snippet', text: a.snippet || '' }))))));
  }
  if (body.answer_box?.snippet) v.append(section('Featured snippet', h('div', { class: 'qa' }, body.answer_box.snippet, body.answer_box.link ? h('div', {}, link(body.answer_box.title || body.answer_box.link, body.answer_box.link)) : null)));

  const organic = (body.organic_results || []).map((r) =>
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
    const side = h('aside', { class: 'kg' }, h('h4', { text: kg.title || '' }), h('div', { class: 'type', text: kg.type || '' }), kg.description ? h('p', { text: kg.description }) : null, kg.source ? link(kg.source.name, kg.source.link) : null, dl, kg.website ? h('div', {}, link('Website', kg.website)) : null);
    v.append(h('div', { class: 'split' }, main, side));
  } else {
    v.append(main);
  }

  if (body.related_questions?.length) {
    v.append(section('People also ask', body.related_questions.map((q) => h('div', { class: 'qa' }, h('b', { text: q.question }), q.snippet || '', q.link ? h('div', {}, link(q.title || q.link, q.link)) : null))));
  }
  if (body.related_searches?.length) v.append(section('Related searches', h('div', { class: 'pillrow' }, body.related_searches.map((r) => searchChip(r.query)))));
  if (body.serpapi_pagination?.next_link && !body.error) {
    v.append(h('div', {}, h('button', { class: 'btn small', type: 'button', text: 'Next page →', onclick: () => { setField('start', new URL(body.serpapi_pagination.next_link).searchParams.get('start')); runSearch(); } })));
  }
}

function setField(name, value) {
  const el = $(`f-${name}`);
  if (el && value != null) el.value = String(value);
  updateCurl();
}

function renderNews(v, items) {
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

function renderShopping(v, items) {
  v.append(section(`Shopping results (${items.length})`, h('div', { class: 'grid-cards' }, items.map((p) =>
    h('div', { class: 'tile' },
      img(p.thumbnail, p.title),
      link(p.title, p.link || p.product_link, 't'),
      h('div', { class: 'price' }, p.price || '', p.old_price ? h('span', { class: 'old', text: p.old_price }) : null),
      h('div', { class: 'small', text: [p.source, p.rating ? `★ ${p.rating}${p.reviews ? ` (${p.reviews.toLocaleString()})` : ''}` : null].filter(Boolean).join(' · ') }),
      p.delivery ? h('div', { class: 'small', text: p.delivery }) : null,
      p.tag ? h('span', { class: 'badge', text: p.tag }) : null)))));
}

function renderImages(v, body) {
  const items = body.images_results;
  v.append(section(`Image results (${items.length})`, h('div', { class: 'grid-cards' }, items.map((i) =>
    h('div', { class: 'tile image' },
      img(i.thumbnail || i.original, i.title || ''),
      link(i.title || i.source || 'Image', i.link, 't'),
      h('div', { class: 'small', text: [i.source, i.original_width && `${i.original_width}×${i.original_height}`].filter(Boolean).join(' · ') }),
      i.original ? link('Original ↗', i.original, 'small') : null)))));
  if (body.suggested_searches?.length) v.append(section('Suggested searches', h('div', { class: 'pillrow' }, body.suggested_searches.map((s) => searchChip(s.q || s.name)))));
}

function sparkline(points) {
  const prices = points.map((p) => p.price).filter((n) => typeof n === 'number');
  if (prices.length < 2) return null;
  const W = 560, H = 120, pad = 6;
  const min = Math.min(...prices), max = Math.max(...prices), span = max - min || 1;
  const x = (i) => pad + (i * (W - pad * 2)) / (prices.length - 1);
  const y = (p) => H - pad - ((p - min) * (H - pad * 2)) / span;
  const d = prices.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p).toFixed(1)}`).join(' ');
  const color = prices.at(-1) >= prices[0] ? 'var(--good)' : 'var(--bad)';
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'sparkline');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Price from ${points[0].date} to ${points.at(-1).date}`);
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

function renderFinance(v, body) {
  const s = body.summary;
  const pm = s.price_movement;
  const dir = pm?.movement === 'Down' ? 'down' : 'up';
  v.append(h('div', { class: 'section' },
    h('div', { class: 'quote' },
      h('div', {}, h('div', { class: 'name', text: `${s.title || ''} ${s.stock ? `· ${s.stock}${s.exchange ? `:${s.exchange}` : ''}` : ''}` }), h('div', { class: 'price', text: s.price || '' })),
      pm ? h('div', { class: dir, text: `${dir === 'down' ? '▼' : '▲'} ${pm.value} (${pm.percentage}%)` }) : null),
    h('div', { class: 'muted', text: s.date || '' }),
    s.market ? h('div', { class: 'muted', text: `${s.market.trading}: ${s.market.price} (${s.market.price_movement?.movement === 'Down' ? '-' : '+'}${s.market.price_movement?.percentage}%)` }) : null));

  const chart = body.graph?.length ? sparkline(body.graph) : null;
  if (chart) v.append(section(`Chart (${body.graph.length} points, ${body.search_parameters?.window || '1D'})`, chart));

  const stats = body.knowledge_graph?.key_stats?.stats;
  if (stats?.length) v.append(section('Key stats', h('div', { class: 'stats' }, stats.map((st) => h('div', { title: st.description }, h('span', { text: st.label }), h('span', { text: st.value }))))));
  const about = body.knowledge_graph?.about;
  if (about) {
    const snippet = about.description?.snippet || '';
    v.append(section('About',
      snippet ? h('p', { class: 'snippet', text: snippet.slice(0, 600) + (snippet.length > 600 ? '…' : '') }) : null,
      h('div', { class: 'stats' }, (about.info || []).map((i) => h('div', {}, h('span', { text: i.label }), h('span', { text: i.value }))))));
  }
  if (body.news_results?.length) renderNews(v, body.news_results.slice(0, 8));
  if (body.discover_more?.[0]?.items?.length) {
    v.append(section(body.discover_more[0].title, h('div', { class: 'pillrow' }, body.discover_more[0].items.map((i) => h('button', { class: 'chip', type: 'button', text: `${i.stock} ${i.price || ''}`, onclick: () => { $('f-q').value = i.stock; runSearch(); } })))));
  }
  if (body.markets) {
    for (const [group, entries] of Object.entries(body.markets)) {
      v.append(section(`Markets: ${group}`, h('div', { class: 'stats' }, entries.map((e) => h('div', {}, h('span', { text: e.name }), h('span', { class: e.price_movement?.movement === 'Down' ? 'down' : 'up', text: `${e.price} ${e.price_movement?.movement === 'Down' ? '▼' : '▲'}${e.price_movement?.percentage}%` }))))));
    }
  }
}

// ---------- views ----------
function setView(view) {
  state.view = view;
  $('view-visual').classList.toggle('active', view === 'visual');
  $('view-json').classList.toggle('active', view === 'json');
  $('view-visual').setAttribute('aria-selected', String(view === 'visual'));
  $('view-json').setAttribute('aria-selected', String(view === 'json'));
  $('visual').hidden = view !== 'visual';
  $('json').hidden = view !== 'json';
}

// ---------- status, settings, history ----------
async function refreshStatus() {
  const { ok, body } = await api('/api/status').catch(() => ({ ok: false }));
  if (!ok) return;
  state.status = body;
  state.settings = body.settings;
  paintSettings();
  const blocked = Object.entries(body.limiter?.hosts || {}).filter(([, s]) => s.blockedForSeconds > 0);
  const notice = $('notice');
  if (blocked.length) {
    notice.hidden = false;
    notice.textContent = `${blocked.map(([host]) => host).join(', ')} blocked this machine (CAPTCHA / HTTP 429). Requests are paused for ${Math.max(...blocked.map(([, s]) => s.blockedForSeconds))}s.`;
  } else {
    notice.hidden = true;
  }
}

function paintSettings() {
  const s = state.settings;
  if (!s) return;
  const pill = $('mode-pill');
  pill.textContent = s.headless ? 'HEADLESS' : 'HTTP';
  pill.className = `pill${s.headless ? ' headless' : ''}`;
  const browser = state.status?.browser;
  pill.title = s.headless ? `Headless browser mode${browser?.running ? ' (browser running)' : ' (browser starts on first search)'}` : 'Lightweight HTTP mode';
  $('headless-toggle').checked = s.headless;
}

async function setHeadless(on) {
  const toggle = $('headless-toggle');
  toggle.disabled = true;
  const res = await patchSettings({ headless: on });
  toggle.disabled = false;
  if (res.ok) {
    state.settings = res.body;
    paintSettings();
    toast(on ? 'Headless mode ON: pages are rendered in Chrome' : 'Headless mode OFF: plain HTTP requests');
    refreshStatus();
  } else {
    toggle.checked = !on;
    toast(res.body.error || 'Could not change the mode');
  }
}

function openSettings() {
  const s = state.settings || {};
  $('s-headless').checked = Boolean(s.headless);
  $('s-fallback').checked = Boolean(s.fallbackToHeadless);
  $('s-robots').value = s.robotsPolicy || 'enforce';
  $('s-interval').value = s.minIntervalMs ?? '';
  $('s-cache').value = s.cacheTtlSeconds ?? '';
  $('settings-error').hidden = true;
  $('robots-warning').hidden = $('s-robots').value === 'enforce';
  $('settings-dialog').showModal();
}

async function saveSettings(evt) {
  evt.preventDefault();
  const res = await patchSettings({
    headless: $('s-headless').checked,
    fallbackToHeadless: $('s-fallback').checked,
    robotsPolicy: $('s-robots').value,
    minIntervalMs: Number($('s-interval').value),
    cacheTtlSeconds: Number($('s-cache').value),
  });
  if (!res.ok) {
    $('settings-error').textContent = res.body.error || 'Invalid settings';
    $('settings-error').hidden = false;
    return;
  }
  state.settings = res.body;
  paintSettings();
  $('settings-dialog').close();
  toast('Settings saved');
  refreshStatus();
}

async function refreshHistory() {
  const { ok, body } = await api('/api/history').catch(() => ({ ok: false }));
  if (!ok) return;
  const list = $('history');
  clear(list);
  if (!body.history.length) list.append(h('li', { class: 'muted', text: 'Nothing yet.' }));
  for (const e of body.history.slice(0, 25)) {
    list.append(h('li', {}, h('button', {
      type: 'button',
      title: e.error || `${e.engine} · ${e.ms} ms`,
      onclick: () => { if (ENGINES[e.engine]) { selectEngine(e.engine, true); $('f-q').value = e.q || ''; updateCurl(); } },
    },
      h('span', { class: `badge ${e.ok ? 'ok' : 'bad'}`, text: e.ok ? (e.mode || 'ok') : (e.code || e.status) }),
      h('span', { class: 'history-q', text: `${ENGINES[e.engine]?.label || e.engine}: ${e.q || ''}` }),
      h('span', { class: 'history-ms', text: `${(e.ms / 1000).toFixed(1)}s` }))));
  }
}

// ---------- wire up ----------
$('search-form').addEventListener('submit', runSearch);
$('search-form').addEventListener('input', updateCurl);
$('f-mode').addEventListener('change', updateCurl);
$('headless-toggle').addEventListener('change', (e) => setHeadless(e.target.checked));
$('open-settings').addEventListener('click', openSettings);
$('settings-form').addEventListener('submit', saveSettings);
$('settings-cancel').addEventListener('click', () => $('settings-dialog').close());
$('s-robots').addEventListener('change', () => ($('robots-warning').hidden = $('s-robots').value === 'enforce'));
$('settings-reset').addEventListener('click', async () => {
  const res = await api('/api/settings', { method: 'DELETE' });
  if (res.ok) { state.settings = res.body; paintSettings(); $('settings-dialog').close(); toast('Reset to environment defaults'); refreshStatus(); }
});
$('view-visual').addEventListener('click', () => setView('visual'));
$('view-json').addEventListener('click', () => setView('json'));
$('refresh-history').addEventListener('click', refreshHistory);
$('copy-curl').addEventListener('click', () => navigator.clipboard?.writeText($('curl').textContent).then(() => toast('curl command copied')));
$('copy-json').addEventListener('click', () => navigator.clipboard?.writeText($('json').textContent).then(() => toast('JSON copied')));

selectEngine('google');
refreshStatus();
refreshHistory();
setInterval(refreshStatus, 5000);
