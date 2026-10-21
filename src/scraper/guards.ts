import { ScraperError } from '../errors.js';
import type { Mode } from '../types.js';

const CAPTCHA_HTML = [
  /id=["']captcha-form["']/i,
  /unusual traffic from your computer network/i,
  /our systems have detected unusual traffic/i,
  /action=["'][^"']*\/sorry\//i,
];

export function looksLikeCaptcha(html: string, url = ''): boolean {
  if (/\/sorry\/(index|image)/.test(url)) return true;
  return CAPTCHA_HTML.some((re) => re.test(html));
}

export function looksLikeConsent(html: string, url = ''): boolean {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    /* ignore */
  }
  return /^consent\.google\./.test(host) || /action=["']https:\/\/consent\.google\.[a-z.]+\/(save|s)/i.test(html);
}

/**
 * Google answers script-less clients with a stub page that only meta-refreshes to
 * /httpservice/retry/enablejs. The same <noscript> block is present in real, rendered SERPs, so
 * only treat the page as a JS wall when no SERP markup exists outside <noscript>/<script>.
 */
export function looksLikeJsWall(html: string): boolean {
  if (!/enablejs/i.test(html)) return false;
  const visible = html.replace(/<(noscript|script)[\s\S]*?<\/\1>/gi, '');
  return !/id=["'](?:search|rso|main|center_col|result-stats)["']|<h3[\s>]/i.test(visible);
}

/**
 * Return a typed error when the response is not a real results page (null when it is usable).
 * `mode` matters only for the JS wall check, which cannot occur in a real browser.
 */
export function classifyPage(
  { html, url, status }: { html: string; url: string; status: number },
  { mode, host }: { mode: Mode; host: string },
): ScraperError | null {
  if (status === 429 || looksLikeCaptcha(html, url)) {
    return new ScraperError(
      'UPSTREAM_BLOCKED',
      `${host} served a CAPTCHA / "unusual traffic" page. Pausing requests; try again later, from a different network, or with a longer RATE_MIN_INTERVAL_MS.`,
      { details: { captcha: true } },
    );
  }
  if (looksLikeConsent(html, url)) {
    return new ScraperError(
      'CONSENT_REQUIRED',
      'Google showed a cookie-consent page that could not be dismissed automatically.',
    );
  }
  if (mode === 'http' && looksLikeJsWall(html)) {
    return new ScraperError(
      'JS_REQUIRED',
      `${host} only serves results to clients that run JavaScript. Turn headless mode ON (or enable the headless fallback) for this search type.`,
    );
  }
  return null;
}
