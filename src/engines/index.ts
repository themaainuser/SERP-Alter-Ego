import { badRequest } from '../errors.js';
import type { Engine, Query } from '../types.js';
import { google, googleImages, googleShopping } from './google.js';
import { googleFinance } from './googleFinance.js';
import { googleNews } from './googleNews.js';

/** An engine name that can map to several engines depending on other parameters (e.g. `tbm`). */
interface EngineFamily {
  id: string;
  resolve(raw: Query): Engine;
}

const ENGINES = new Map<string, Engine | EngineFamily>([
  ['google', google],
  ['google_news', googleNews],
  ['google_shopping', googleShopping],
  ['google_images', googleImages],
  ['google_finance', googleFinance],
]);

export const ENGINE_IDS = [...ENGINES.keys()];

/** Look up the engine for a raw query; `engine=google` may resolve to a tab (tbm) variant. */
export function resolveEngine(raw: Query): Engine {
  const value = raw.engine;
  const name = Array.isArray(value) ? value.at(-1) : (value ?? 'google');
  const engine = ENGINES.get(String(name));
  if (!engine) throw badRequest(`Unsupported \`${String(name)}\` search engine. Supported: ${ENGINE_IDS.join(', ')}.`);
  return 'resolve' in engine ? engine.resolve(raw) : engine;
}
