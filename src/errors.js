/**
 * Typed errors. Each carries a stable machine-readable `code`, the HTTP status the API
 * should answer with, and optional `retryAfter` seconds.
 */
export const ERROR_STATUS = Object.freeze({
  INVALID_PARAMETER: 400,
  NOT_FOUND: 404,
  ROBOTS_DISALLOWED: 403,
  ROBOTS_UNAVAILABLE: 503,
  RATE_LIMITED: 429,
  UPSTREAM_BLOCKED: 429,
  CONSENT_REQUIRED: 503,
  JS_REQUIRED: 503,
  BROWSER_UNAVAILABLE: 503,
  UPSTREAM_NETWORK_ERROR: 502,
  UPSTREAM_HTTP_ERROR: 502,
  UPSTREAM_TIMEOUT: 504,
  PARSE_ERROR: 502,
  INTERNAL_ERROR: 500,
});

export class ScraperError extends Error {
  constructor(code, message, { cause, retryAfter, details } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ScraperError';
    this.code = code;
    this.status = ERROR_STATUS[code] ?? 500;
    if (retryAfter != null) this.retryAfter = Math.max(1, Math.ceil(retryAfter));
    if (details) this.details = details;
  }
}

export const badRequest = (message) => new ScraperError('INVALID_PARAMETER', message);

/** Wrap anything thrown into a ScraperError so callers can rely on `.code`/`.status`. */
export function toScraperError(err) {
  if (err instanceof ScraperError) return err;
  return new ScraperError('INTERNAL_ERROR', 'Unexpected internal error.', { cause: err });
}
