import type { Config } from '../config.js';
import { badRequest } from '../errors.js';
import type { BaseParams, Defaults, Query } from '../types.js';

export interface StrOptions {
  max?: number;
  pattern?: RegExp;
  hint?: string;
}
export interface IntOptions {
  min?: number;
  max?: number;
}

/** Typed, validating reader over a raw query-string object (Express `req.query`). */
export interface ParamReader {
  has(key: string): boolean;
  str(key: string, options?: StrOptions): string | undefined;
  int(key: string, options?: IntOptions): number | undefined;
  bool(key: string): boolean | undefined;
  enum<T extends string>(key: string, values: readonly T[]): T | undefined;
}

export function reader(raw: Query = {}): ParamReader {
  const get = (key: string): string | undefined => {
    const v = raw[key];
    const s = Array.isArray(v) ? v[v.length - 1] : v;
    if (s === undefined || s === null) return undefined;
    const str = String(s);
    return str === '' ? undefined : str;
  };
  return {
    has: (key) => get(key) !== undefined,
    str(key, { max = 512, pattern, hint } = {}) {
      const v = get(key);
      if (v === undefined) return undefined;
      if (v.length > max) throw badRequest(`\`${key}\` is too long (max ${max} characters).`);
      if (pattern && !pattern.test(v)) throw badRequest(`Invalid \`${key}\` parameter${hint ? `: ${hint}` : ''}.`);
      return v;
    },
    int(key, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
      const v = get(key);
      if (v === undefined) return undefined;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`\`${key}\` must be an integer between ${min} and ${max}.`);
      return n;
    },
    bool(key) {
      const v = get(key);
      if (v === undefined) return undefined;
      if (/^(true|1)$/i.test(v)) return true;
      if (/^(false|0)$/i.test(v)) return false;
      throw badRequest(`\`${key}\` must be true or false.`);
    },
    enum<T extends string>(key: string, values: readonly T[]): T | undefined {
      const v = get(key);
      if (v === undefined) return undefined;
      if (!(values as readonly string[]).includes(v)) throw badRequest(`\`${key}\` must be one of: ${values.join(', ')}.`);
      return v as T;
    },
  };
}

const HL = /^[a-z]{2,3}(-[A-Za-z]{2,4}|-\d{3})?$/;
const GL = /^[a-zA-Z]{2}$/;
// Only Google's own domains: this value ends up in an outbound URL.
const GOOGLE_DOMAIN = /^(www\.)?google\.[a-z]{2,3}(\.[a-z]{2})?$/i;

export type CommonParams = Pick<BaseParams, 'hl' | 'gl' | 'google_domain' | 'device' | 'no_cache' | 'output' | 'headless'>;

/** Parameters shared by every engine. */
export function readCommon(r: ParamReader, defaults: Defaults): CommonParams {
  const device = r.enum('device', ['desktop', 'tablet', 'mobile'] as const) ?? 'desktop';
  if (device !== 'desktop') throw badRequest('Only `device=desktop` is supported by this scraper.');
  return {
    hl: r.str('hl', { pattern: HL, hint: 'expected a language code such as `en` or `pt-br`' }) ?? defaults.hl,
    gl: (r.str('gl', { pattern: GL, hint: 'expected a two-letter country code' }) ?? defaults.gl).toLowerCase(),
    google_domain: (r.str('google_domain', { pattern: GOOGLE_DOMAIN, hint: 'expected a Google domain such as `google.com`' }) ?? defaults.googleDomain).toLowerCase(),
    device,
    no_cache: r.bool('no_cache') ?? false,
    output: r.enum('output', ['json', 'html'] as const) ?? 'json',
    headless: r.bool('headless'),
  };
}

const UULE_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Encode a canonical Google location name (e.g. "Austin, Texas, United States") as `uule`. */
export function encodeUule(canonicalName: string): string | undefined {
  const name = String(canonicalName);
  if (!name || name.length >= UULE_KEYS.length) return undefined;
  // Google's uule values carry no base64 padding.
  return `w+CAIQICI${UULE_KEYS[name.length]}${Buffer.from(name).toString('base64').replace(/=+$/, '')}`;
}

export function googleOrigin(domain: string, config: Config): string {
  if (config.upstream.googleBase) return config.upstream.googleBase.replace(/\/$/, '');
  return `https://${domain.startsWith('www.') ? domain : `www.${domain}`}`;
}
