import { compact, parseError, relativeTime } from './common.js';

/* Google Finance embeds its data as positional JSON arrays in AF_initDataCallback blocks.
 * Block numbers (ds:N) change between pages, so values are located by *shape*, not by key. */

const MARKET_GROUPS = { 1: 'us', 2: 'europe', 3: 'asia', 4: 'currencies', 5: 'crypto', 7: 'futures' };

/** Pull every `AF_initDataCallback({... data: <json> ...})` payload out of a page. */
export function extractDataBlocks(html) {
  const blocks = [];
  const re = /AF_initDataCallback\(\{key:\s*'(ds:\d+)',\s*hash:\s*'[^']*',\s*data:/g;
  let m;
  while ((m = re.exec(html))) {
    const json = readJsonValue(html, m.index + m[0].length);
    if (json == null) continue;
    try {
      blocks.push(JSON.parse(json));
    } catch {
      /* a block we cannot decode is simply skipped */
    }
  }
  return blocks;
}

/** Slice one balanced JSON array/object starting at `start`, respecting strings. */
function readJsonValue(text, start) {
  const open = text[start];
  if (open !== '[' && open !== '{') return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Decode the payloads of Google's batchexecute XHR responses (")]}'" + length-prefixed JSON). */
export function decodeBatchExecute(body) {
  const payloads = [];
  const start = body.indexOf('[[');
  if (start < 0) return payloads;
  let outer;
  try {
    outer = JSON.parse(readJsonValue(body, start));
  } catch {
    return payloads;
  }
  for (const row of outer) {
    if (row?.[0] === 'wrb.fr' && typeof row[2] === 'string') {
      try {
        payloads.push(JSON.parse(row[2]));
      } catch {
        /* ignore undecodable rows */
      }
    }
  }
  return payloads;
}

/** True when a decoded batchexecute payload carries chart data. */
export function containsGraph(payload) {
  for (const node of walk(payload)) if (isGraph(node)) return true;
  return false;
}

function* walk(node) {
  if (!Array.isArray(node)) return;
  yield node;
  for (const child of node) yield* walk(child);
}

const isQuote = (a) =>
  Array.isArray(a) &&
  a.length >= 8 &&
  typeof a[0] === 'string' &&
  /^\/[mg]\//.test(a[0]) &&
  typeof a[2] === 'string' &&
  Array.isArray(a[5]) &&
  typeof a[5][0] === 'number';

const isNewsItem = (a) =>
  Array.isArray(a) && typeof a[0] === 'string' && /^https?:\/\//.test(a[0]) && typeof a[1] === 'string' && typeof a[2] === 'string' && typeof a[4] === 'number';
const isNewsList = (a) => Array.isArray(a) && a.length > 0 && a.every(isNewsItem);

const isAbout = (a) =>
  Array.isArray(a) && typeof a[0] === 'string' && /^\/[mg]\//.test(a[0]) && typeof a[1] === 'string' && typeof a[2] === 'string' && a[2].length > 40 && Array.isArray(a[3]);

const isGraph = (a) =>
  Array.isArray(a) &&
  (a[0] === null || (Array.isArray(a[0]) && a[0].length === 2 && typeof a[0][0] === 'string')) &&
  typeof a[1] === 'string' &&
  (typeof a[2] === 'string' || a[2] === null) &&
  Array.isArray(a[3]) &&
  Array.isArray(a[3][0]);

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const currencySymbol = (code) => {
  if (!code) return '';
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: code }).formatToParts(0).find((p) => p.type === 'currency')?.value ?? code;
  } catch {
    return code;
  }
};
const formatAmount = (n, decimals = 2) =>
  n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

function utcLabel(offsetSeconds = 0) {
  const sign = offsetSeconds < 0 ? '-' : '+';
  const abs = Math.abs(offsetSeconds);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  return { sign, h, m };
}

/** "Sep 30, 4:00:01 PM UTC-4" */
function formatSummaryDate(epochSeconds, offsetSeconds = 0) {
  const d = new Date((epochSeconds + offsetSeconds) * 1000);
  const { sign, h, m } = utcLabel(offsetSeconds);
  const hour = d.getUTCHours();
  const tz = `UTC${sign}${h}${m ? `:${pad(m)}` : ''}`;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${hour % 12 || 12}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${hour < 12 ? 'AM' : 'PM'} ${tz}`;
}

/** "Sep 30 2026, 09:30 AM UTC-04:00" from a Google [Y,M,D,h,m,_,_,[offset]] array. */
function formatGraphDate(parts, fallbackOffset = 0) {
  const [y, mo, d] = parts;
  const h = parts[3] ?? 0;
  const mi = parts[4] ?? 0;
  const offset = parts[7]?.[0] ?? fallbackOffset;
  const { sign, h: oh, m: om } = utcLabel(offset);
  return `${MONTHS[mo - 1]} ${pad(d)} ${y}, ${pad(h % 12 || 12)}:${pad(mi)} ${h < 12 ? 'AM' : 'PM'} UTC${sign}${pad(oh)}:${pad(om)}`;
}

function formatIsoGraphDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):\d{2}([+-])(\d{2}):(\d{2})$/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d, h, mi, sign, oh, om] = m;
  const hr = Number(h);
  return `${MONTHS[Number(mo) - 1]} ${d} ${y}, ${pad(hr % 12 || 12)}:${mi} ${hr < 12 ? 'AM' : 'PM'} UTC${sign}${oh}:${om}`;
}

function priceMovement(change, pct, decimals = 2) {
  return { percentage: round(Math.abs(pct)), value: round(Math.abs(change), decimals), movement: change < 0 || pct < 0 ? 'Down' : 'Up' };
}
const decimalsOf = (q) => (Number.isInteger(q[5][3]) ? q[5][3] : 2);

function formatQuotePrice(q, value) {
  const decimals = Number.isInteger(q[5][3]) ? q[5][3] : 2;
  return `${currencySymbol(q[4])}${formatAmount(value, decimals)}`;
}

function quoteSymbol(q) {
  return typeof q[21] === 'string' ? q[21] : Array.isArray(q[1]) ? q[1].join(':') : null;
}

function toStockEntry(q, hl) {
  const stock = quoteSymbol(q);
  return compact({
    stock,
    link: stock ? `https://www.google.com/finance/quote/${stock}?hl=${hl}` : undefined,
    name: q[2],
    price: formatQuotePrice(q, q[5][0]),
    extracted_price: q[5][0],
    price_movement: priceMovement(q[5][1], q[5][2], decimalsOf(q)),
  });
}

function buildSummary(q, nowMs) {
  const [stock, exchange] = Array.isArray(q[1]) ? q[1] : [null, null];
  const offset = typeof q[13] === 'number' ? q[13] : 0;
  const ts = q[17]?.[0] ?? q[11]?.[0];
  const summary = compact({
    title: q[2],
    stock: stock ?? quoteSymbol(q),
    exchange,
    price: formatQuotePrice(q, q[5][0]),
    extracted_price: q[5][0],
    currency: currencySymbol(q[4]),
    date: ts ? formatSummaryDate(ts, offset) : undefined,
    price_movement: priceMovement(q[5][1], q[5][2], decimalsOf(q)),
  });
  const ext = q[16];
  if (Array.isArray(ext) && typeof ext[0] === 'number') {
    const extTs = q[18]?.[0] ?? q[11]?.[0];
    const localHour = extTs ? new Date((extTs + offset) * 1000).getUTCHours() : 0;
    summary.market = {
      trading: localHour < 12 ? 'Pre-market' : 'After Hours',
      price: formatQuotePrice(q, ext[0]),
      extracted_price: ext[0],
      price_movement: priceMovement(ext[1], ext[2], decimalsOf(q)),
    };
  }
  return summary;
}

/** Build the graph for the first block carrying regular-session / daily points. */
function buildGraph(graphNodes, currencyCode) {
  for (const g of graphNodes) {
    const code = g[2] || currencyCode;
    for (const w of g[3]) {
      const header = w?.[0];
      if (!Array.isArray(header)) continue;
      const detailed = w[1];
      if (Array.isArray(detailed) && detailed.length && Array.isArray(detailed[0]?.[0])) {
        const sessionOnly = header[0] === 1;
        if (!sessionOnly) continue;
        const offset = header[1]?.[7]?.[0] ?? 0;
        return detailed.map(([when, quote, volume]) =>
          compact({ price: quote[0], currency: code, date: formatGraphDate(when, offset), volume }),
        );
      }
      const ohlc = w[2];
      if (Array.isArray(ohlc) && ohlc.length && typeof ohlc[0]?.[4] === 'string') {
        return ohlc.map((p) => compact({ price: p[1], currency: code, date: formatIsoGraphDate(p[4]), volume: p[5] }));
      }
    }
  }
  return [];
}

function buildAbout(a, quote) {
  const [city, region, country] = Array.isArray(a[3]) ? a[3] : [];
  const hq = [city, region, country].filter(Boolean).join(', ');
  const founded = Array.isArray(a[4]) && a[4].length === 3 ? `${MONTHS[a[4][1] - 1]} ${a[4][2]}, ${a[4][0]}` : null;
  const employees = typeof a[6] === 'number' ? new Intl.NumberFormat('en', { notation: 'compact', maximumSignificantDigits: 3 }).format(a[6]) : null;
  const website = typeof a[22] === 'string' ? a[22] : null;
  const wiki = typeof a[30] === 'string' ? a[30] : null;
  const info = [
    a[5] && { label: 'CEO', value: a[5] },
    founded && { label: 'Founded', value: founded },
    hq && { label: 'Headquarters', value: hq },
    website && { label: 'Website', value: website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''), link: website },
    employees && { label: 'Employees', value: employees },
  ].filter(Boolean);
  return { description: compact({ snippet: a[2], link: wiki }), info };
}

function buildStats(a, q) {
  const cur = currencySymbol(a[15] || q[4]);
  const money = (n) => (typeof n === 'number' ? `${cur}${formatAmount(n)}` : null);
  const compactMoney = (n) =>
    typeof n === 'number' ? `${cur}${new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(n)}` : null;
  const compactNum = (n) => (typeof n === 'number' ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(n) : null);
  const range = (lo, hi) => (typeof lo === 'number' && typeof hi === 'number' ? `${money(lo)} - ${money(hi)}` : null);
  const rows = [
    ['Previous close', 'The last closing price', money(a[8])],
    ['Day range', 'The range between the high and low prices over the past day', range(a[11], a[10])],
    ['Year range', 'The range between the high and low prices over the past 52 weeks', range(a[13], a[12])],
    ['Market cap', 'Share price multiplied by the number of shares outstanding', compactMoney(a[7])],
    ['P/E ratio', 'Ratio of the current share price to trailing twelve month EPS', typeof a[16] === 'number' ? String(round(a[16])) : null],
    ['Dividend yield', 'Annual dividend payment divided by the share price', typeof a[17] === 'number' ? `${round(a[17])}%` : null],
    ['Primary exchange', 'Listed on this stock exchange', a[24] || null],
    ['Shares outstanding', 'Number of shares currently held by investors', compactNum(a[21])],
  ];
  return rows.filter((r) => r[2]).map(([label, description, value]) => ({ label, description, value }));
}

/**
 * Parse a Google Finance quote page (HTTP HTML or the rendered DOM) into SerpApi's
 * google_finance structure. `extras.payloads` may carry decoded XHR payloads with graph data
 * for a non-default window.
 */
export function parseFinance(html, { symbol, hl = 'en', extras, nowMs = Date.now() } = {}) {
  const blocks = extractDataBlocks(html);
  if (!blocks.length) throw parseError('Google Finance page contained no data blocks; the page layout may have changed.');

  const quotes = [];
  const newsLists = [];
  const aboutNodes = [];
  const graphNodes = [];
  const quoteLists = [];
  const marketGroups = [];

  for (const block of blocks) {
    for (const node of walk(block)) {
      if (isQuote(node)) quotes.push(node);
      else if (isNewsList(node)) newsLists.push(node);
      else if (isAbout(node)) aboutNodes.push(node);
      else if (isGraph(node)) graphNodes.push(node);
      else if (node.length >= 2 && node.every(isQuote)) quoteLists.push(node);
      else if (typeof node[0] === 'number' && MARKET_GROUPS[node[0]] && Array.isArray(node[1]) && node[1].length && node[1].every((x) => Array.isArray(x) && isQuote(x[1]?.[0]))) {
        marketGroups.push(node);
      }
    }
  }

  const wanted = String(symbol || '').toUpperCase();
  const main = quotes.find((q) => quoteSymbol(q)?.toUpperCase() === wanted);
  if (!main) return { empty: true };

  const windowGraphs = [];
  for (const payload of extras?.payloads ?? []) for (const node of walk(payload)) if (isGraph(node)) windowGraphs.push(node);
  const graph = buildGraph(windowGraphs.length ? windowGraphs : graphNodes.filter((g) => g[1] === main[0]), main[4]);

  const result = { summary: buildSummary(main, nowMs), graph };
  if (extras?.windowOnly) return result;

  const about = aboutNodes.find((a) => a[0] === main[0]) ?? aboutNodes[0];
  if (about) {
    const key_stats = { tags: about[71] ? [{ text: about[71] }] : [], stats: buildStats(about, main) };
    result.knowledge_graph = { key_stats, about: buildAbout(about, main) };
  }

  // Several lists exist (this entity's news, plus general market news); the entity's own items are tagged with its id.
  const tagged = (list) => list.filter((n) => Array.isArray(n[9]) && n[9].includes(main[0])).length;
  const news = newsLists.length ? newsLists.reduce((best, l) => (tagged(l) > tagged(best) ? l : best)) : [];
  result.news_results = news.slice(0, 20).map((n, i) => {
    const thumb = typeof n[3] === 'string' && !/faviconV2/.test(n[3]) ? n[3] : undefined;
    const headline = n[1];
    const summary = typeof n[16] === 'string' ? n[16].replace(/\s+/g, ' ').trim() : undefined;
    return compact({
      position: i + 1,
      link: n[0],
      source: n[2],
      date: relativeTime(n[4], nowMs),
      title: headline,
      snippet: summary || headline,
      thumbnail: thumb,
    });
  });

  const markets = {};
  for (const group of marketGroups) {
    const key = MARKET_GROUPS[group[0]];
    markets[key] = group[1].map((entry) => {
      const item = toStockEntry(entry[1][0], hl);
      if (typeof entry[2] === 'string') item.name = entry[2];
      return item;
    });
  }
  if (Object.keys(markets).length) result.markets = markets;

  const similar = quoteLists.find((l) => !l.some((q) => q[0] === main[0]));
  if (similar) result.discover_more = [{ title: 'People also search for', items: similar.map((q) => toStockEntry(q, hl)) }];

  return result;
}

