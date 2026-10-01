import { badRequest } from '../errors.js';
import { google, googleImages, googleShopping } from './google.js';
import { googleNews } from './googleNews.js';
import { googleFinance } from './googleFinance.js';

const ENGINES = new Map([
  ['google', google],
  ['google_news', googleNews],
  ['google_shopping', googleShopping],
  ['google_images', googleImages],
  ['google_finance', googleFinance],
]);

export const ENGINE_IDS = [...ENGINES.keys()];

/** Look up the engine for a raw query; `engine=google` may resolve to a tab (tbm) variant. */
export function resolveEngine(raw) {
  const name = Array.isArray(raw.engine) ? raw.engine.at(-1) : raw.engine ?? 'google';
  const engine = ENGINES.get(String(name));
  if (!engine) throw badRequest(`Unsupported \`${name}\` search engine. Supported: ${ENGINE_IDS.join(', ')}.`);
  return engine.resolve ? engine.resolve(raw) : engine;
}
