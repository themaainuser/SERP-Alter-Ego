import { ScraperError } from '../errors.js';

export const clean = (s) => String(s ?? '').replace(/[\u00a0\s]+/g, ' ').trim();

export const snakeCase = (label) =>
  clean(label)
    .toLowerCase()
    .replace(/[:：]+$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');

export function parseNumber(str) {
  const n = Number(String(str ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Resolve `href` against `base`; returns null for non-http(s) or unparseable values. */
export function absoluteUrl(href, base) {
  if (!href) return null;
  try {
    const u = new URL(href, base);
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

export const isGoogleHost = (host) => /(^|\.)google\.[a-z.]+$/i.test(host) || /(^|\.)gstatic\.com$/i.test(host);

/** Google wraps outbound links as /url?q=<target>; return the real target when present. */
export function unwrapGoogleRedirect(href, base = 'https://www.google.com') {
  const abs = absoluteUrl(href, base);
  if (!abs) return null;
  const u = new URL(abs);
  if (isGoogleHost(u.hostname) && u.pathname === '/url') {
    const target = u.searchParams.get('q') || u.searchParams.get('url');
    return absoluteUrl(target, base);
  }
  return abs;
}

const CURRENCY_TOKEN =
  String.raw`(?:[A-Z]{1,3}\$|[$€£¥₹₩₽₺₫₪฿₱₴₦]|(?:USD|EUR|GBP|CAD|AUD|INR|JPY|CHF|CNY|MXN|BRL)\s?)`;
const AMOUNT = String.raw`\d[\d.,\u00a0\u202f ]*\d|\d`;
const PRICE_RE = new RegExp(
  String.raw`(?:${CURRENCY_TOKEN}\s?(?:${AMOUNT}))|(?:(?:${AMOUNT})\s?(?:[$€£¥₹₽₺]|zł|kr|Kč|lei|руб\.?|TL)(?![\p{L}\d]))`,
  'u',
);

/** Normalise "1,299.00", "1.299,00", "1 299,00" -> 1299. */
export function normalizeAmount(raw) {
  let s = String(raw).replace(/[\u00a0\u202f\s]/g, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma > -1) {
    s = /,\d{1,2}$/.test(s) && s.indexOf(',') === lastComma ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Find the first price in `text`: { price: "$19.99", extracted_price: 19.99 } or null. */
export function findPrice(text) {
  const m = PRICE_RE.exec(String(text ?? ''));
  if (!m) return null;
  const price = clean(m[0]);
  const amount = /\d[\d.,\u00a0\u202f ]*/.exec(price)?.[0];
  const extracted = amount ? normalizeAmount(amount) : null;
  return extracted == null ? null : { price, extracted_price: extracted };
}

/** Collect visible text nodes as separate trimmed strings (keeps block boundaries apart). */
export function textLines($, el) {
  const out = [];
  const walk = (node) => {
    if (node.type === 'text') {
      const t = clean(node.data);
      if (t) out.push(t);
    } else if (node.type === 'tag' && !['script', 'style', 'noscript'].includes(node.name)) {
      (node.children || []).forEach(walk);
    }
  };
  $(el).each((_, node) => walk(node));
  return out;
}

export function relativeTime(epochSeconds, nowMs = Date.now()) {
  const diff = Math.max(0, Math.round((nowMs / 1000 - epochSeconds) / 60));
  if (diff < 1) return 'Just now';
  if (diff < 60) return `${diff} minute${diff === 1 ? '' : 's'} ago`;
  const hours = Math.floor(diff / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

/** SerpApi news date format: "10/01/2026, 10:11 AM, +0000 UTC". */
export function formatNewsDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  const h = d.getUTCHours();
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${d.getUTCFullYear()}, ${p(h % 12 || 12)}:${p(d.getUTCMinutes())} ${h < 12 ? 'AM' : 'PM'}, +0000 UTC`;
}

export function parseError(message, details) {
  return new ScraperError('PARSE_ERROR', message, { details });
}

/** Drop undefined/null/empty-string/empty-array values so output mirrors SerpApi's sparse objects. */
export function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}
