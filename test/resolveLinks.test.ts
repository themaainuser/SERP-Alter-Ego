import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEncryptedLinks } from '../src/engines/resolveLinks.js';

/**
 * A fake `fetch` that records every request and answers /goto redirects from a map.
 * Any URL not in the map gets a 200 with no Location (unresolvable).
 */
function fakeFetch(redirects: Record<string, string>, opts: { delayMs?: number } = {}) {
  const calls: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const location = redirects[url];
      return new Response(location ? '' : 'no redirect', {
        status: location ? 302 : 200,
        headers: location ? { location } : {},
      });
    } finally {
      inFlight--;
    }
  }) as unknown as typeof globalThis.fetch;
  return { calls, peak: () => peak, fetchImpl };
}

const GOTO = (blob: string) => `https://www.google.com/goto?url=${blob}`;

describe('resolveEncryptedLinks', () => {
  it('rewrites /goto links to the Location target', async () => {
    const { fetchImpl } = fakeFetch({ [GOTO('aaa')]: 'https://blog.example.org/grind-guide' });
    const results = [{ link: GOTO('aaa') }];
    const n = await resolveEncryptedLinks(results, { fetchImpl });
    assert.equal(n, 1);
    assert.equal(results[0].link, 'https://blog.example.org/grind-guide');
  });

  it('leaves non-goto links untouched and resolves nothing', async () => {
    const { calls, fetchImpl } = fakeFetch({});
    const results = [{ link: 'https://www.example.com/plain' }, { link: 'https://other.example.net/x' }];
    const n = await resolveEncryptedLinks(results, { fetchImpl });
    assert.equal(n, 0);
    assert.equal(calls.length, 0); // no requests made for non-goto links
    assert.equal(results[0].link, 'https://www.example.com/plain');
  });

  it('keeps the original link when a lookup fails (no Location)', async () => {
    const { fetchImpl } = fakeFetch({}); // nothing redirectable
    const results = [{ link: GOTO('aaa') }];
    const n = await resolveEncryptedLinks(results, { fetchImpl });
    assert.equal(n, 0);
    assert.equal(results[0].link, GOTO('aaa')); // unchanged, not dropped
  });

  it('keeps the original link when fetch throws', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as unknown as typeof globalThis.fetch;
    const results = [{ link: GOTO('aaa') }];
    const n = await resolveEncryptedLinks(results, { fetchImpl });
    assert.equal(n, 0);
    assert.equal(results[0].link, GOTO('aaa'));
  });

  it('makes no requests at all when disabled', async () => {
    const { calls, fetchImpl } = fakeFetch({ [GOTO('aaa')]: 'https://real.example.com' });
    const results = [{ link: GOTO('aaa') }];
    const n = await resolveEncryptedLinks(results, { fetchImpl, enabled: false });
    assert.equal(n, 0);
    assert.equal(calls.length, 0);
    assert.equal(results[0].link, GOTO('aaa'));
  });

  it('bounds concurrency to the configured limit', async () => {
    const redirects: Record<string, string> = {};
    const results: { link: string }[] = [];
    for (let i = 0; i < 12; i++) {
      redirects[GOTO(`b${i}`)] = `https://real.example.com/${i}`;
      results.push({ link: GOTO(`b${i}`) });
    }
    const { peak, fetchImpl } = fakeFetch(redirects, { delayMs: 15 });
    const n = await resolveEncryptedLinks(results, { fetchImpl, concurrency: 3 });
    assert.equal(n, 12);
    assert.ok(peak() <= 3, `expected peak concurrency <= 3, saw ${peak()}`);
    for (let i = 0; i < 12; i++) assert.equal(results[i].link, `https://real.example.com/${i}`);
  });

  it('resolves a relative Location against the goto URL', async () => {
    const { fetchImpl } = fakeFetch({ [GOTO('rel')]: '/relative/target' });
    const results = [{ link: GOTO('rel') }];
    await resolveEncryptedLinks(results, { fetchImpl });
    assert.equal(results[0].link, 'https://www.google.com/relative/target');
  });

  it('rejects a non-http Location and keeps the original link', async () => {
    const { fetchImpl } = fakeFetch({ [GOTO('js')]: 'javascript:alert(1)' });
    const results = [{ link: GOTO('js') }];
    const n = await resolveEncryptedLinks(results, { fetchImpl });
    assert.equal(n, 0);
    assert.equal(results[0].link, GOTO('js'));
  });

  it('handles an empty or missing results list without error', async () => {
    assert.equal(await resolveEncryptedLinks([]), 0);
    assert.equal(await resolveEncryptedLinks(undefined), 0);
  });
});
