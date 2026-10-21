import { isEncryptedRedirect } from '../parsers/common.js';

/**
 * Google's web & news-tab results increasingly point at an ENCRYPTED redirect:
 * `https://www.google.com/goto?url=<base64 blob>`. Only Google can decode the blob, but a
 * plain GET to that URL answers `302 Moved` with the real destination in the `Location`
 * header. This resolves those links back to their real URLs so downstream consumers see
 * genuine destinations instead of opaque google.com/goto links.
 *
 * Design constraints:
 * - Best-effort: a link that cannot be resolved keeps its original `/goto` value rather than
 *   being dropped, so a single failing request never loses a result.
 * - Bounded concurrency: we never open more than `concurrency` requests at once, so a
 *   10-result page does not fire 10 simultaneous hits at Google (which would look bot-like).
 * - Configurable & disableable: `GOOGLE_RESOLVE_LINKS=false` skips all follow-up requests.
 */

export interface ResolveOptions {
  /** Max simultaneous redirect lookups. */
  concurrency?: number;
  /** Per-request timeout for one `/goto` lookup. */
  timeoutMs?: number;
  /** `false` disables resolution entirely (links are left as-is). */
  enabled?: boolean;
  /** User-Agent sent with each lookup; defaults to Node's fetch UA. */
  userAgent?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof globalThis.fetch;
}

const DEFAULTS = { concurrency: 4, timeoutMs: 6000, enabled: true } as const;

/** Replace encrypted `/goto` links in-place with their real destinations. Returns count resolved. */
export async function resolveEncryptedLinks<T extends { link?: string }>(
  results: readonly T[] | undefined,
  options: ResolveOptions = {},
): Promise<number> {
  if (!results?.length) return 0;
  const { concurrency, timeoutMs, enabled, userAgent, fetchImpl } = { ...DEFAULTS, ...options };
  if (!enabled) return 0;

  const targets = results.filter((r) => typeof r.link === 'string' && isEncryptedRedirect(r.link));
  if (!targets.length) return 0;

  const doFetch = fetchImpl ?? globalThis.fetch;
  let cursor = 0;
  let resolved = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= targets.length) return;
      const result = targets[index] as T & { link: string };
      const real = await resolveOne(result.link, { timeoutMs, userAgent, doFetch });
      if (real) {
        result.link = real;
        resolved++;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  return resolved;
}

/** Follow a single `/goto` redirect and return the `Location` target, or null on any failure. */
async function resolveOne(
  gotoUrl: string,
  { timeoutMs, userAgent, doFetch }: { timeoutMs: number; userAgent?: string; doFetch: typeof globalThis.fetch },
): Promise<string | null> {
  try {
    const headers: Record<string, string> = { accept: 'text/html,*/*' };
    if (userAgent) headers['user-agent'] = userAgent;
    const res = await doFetch(gotoUrl, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers });
    const location = res.headers.get('location');
    // Drain the (tiny) body so the socket is released, then validate.
    await res.body?.cancel().catch(() => {});
    if (!location) return null;
    const url = new URL(location, gotoUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null; // timeout / network / non-http location -> keep the original link
  }
}
