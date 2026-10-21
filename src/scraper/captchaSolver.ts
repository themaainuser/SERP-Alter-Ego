import type { Page } from "puppeteer";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";

/**
 * Optional third-party CAPTCHA solving (OFF by default). The human-in-loop wait in `browser.ts`
 * remains the default solver and needs no account; this adapter is the unattended backup for
 * anyone who would rather pay than watch a window — you must set BOTH `CAPTCHA_SOLVER=2captcha`
 * and `CAPTCHA_SOLVER_API_KEY`, or nothing here runs.
 *
 * It does one Google-specific job: turn a `/sorry/` reCAPTCHA into a token and get the page to
 * accept it. Flow — extract the reCAPTCHA sitekey from the challenge page -> hand the task to
 * the solver and poll for a token -> inject the token and fire reCAPTCHA's callback (or submit
 * the form) -> wait for Google to redirect back to the results.
 *
 * Every step is best-effort: any failure logs and returns `false` so the caller can fall back
 * to the human-in-loop wait rather than losing the scrape.
 *
 * Tested against a fake fetch/page (no live account, no live spend) — see test/captchaSolver.test.ts.
 */

const POLL_MS = 5000;
const REQUEST_TIMEOUT_MS = 15000;
const SOLVED_WAIT_CAP_MS = 15000;

type BrowserCfg = Config["browser"];

/** True only when a known solver is configured WITH an API key (both required). */
export function solverEnabled(cfg: BrowserCfg): boolean {
  return cfg.captchaSolver === "2captcha" && Boolean(cfg.captchaSolverKey);
}

/**
 * Pull the reCAPTCHA sitekey out of a Google `/sorry/` page. Google has shipped it in a few
 * shapes across deployments, so try the common ones in order.
 */
export function extractSitekey(html: string): string | null {
  const patterns = [
    /data-sitekey=["']([0-9A-Za-z_-]{20,})["']/,
    /\/recaptcha\/api[^"' <]*?[?&]k=([0-9A-Za-z_-]{20,})/,
    /[?&]k=([0-9A-Za-z_-]{30,})/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) return match[1];
  }
  return null;
}

export interface SolveOptions {
  /** Injectable for tests (defaults to Node's global fetch). */
  fetchImpl?: typeof globalThis.fetch;
}

/**
 * Attempt to solve the CAPTCHA currently shown by `page`. Returns true only once the page has
 * actually left `/sorry/`; false means "not solved" (caller falls back / reports the block).
 */
export async function solveSorryCaptcha(
  page: Page,
  cfg: BrowserCfg,
  logger?: Logger,
  { fetchImpl = globalThis.fetch }: SolveOptions = {},
): Promise<boolean> {
  const apiKey = cfg.captchaSolverKey;
  if (!apiKey) return false;
  try {
    const pageurl = page.url();
    const sitekey = extractSitekey(await page.content());
    if (!sitekey) {
      logger?.warn("CAPTCHA solver: no reCAPTCHA sitekey found on the challenge page.", { url: pageurl });
      return false;
    }
    const token = await requestToken({
      apiKey,
      sitekey,
      pageurl,
      timeoutMs: cfg.captchaSolverTimeoutMs,
      fetchImpl,
      logger,
    });
    if (!token) return false;

    await page.evaluate(injectTokenAndSubmit, token);

    // Google redirects off /sorry/ once it accepts the token; wait for that, not a fixed sleep.
    return await waitOffSorry(page, Math.min(cfg.captchaSolverTimeoutMs, SOLVED_WAIT_CAP_MS));
  } catch (err) {
    logger?.warn("CAPTCHA solver failed; falling back to the human-in-loop wait.", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Submit the task to the solver, then poll until it returns a token (or give up). */
async function requestToken({
  apiKey,
  sitekey,
  pageurl,
  timeoutMs,
  fetchImpl,
  logger,
}: {
  apiKey: string;
  sitekey: string;
  pageurl: string;
  timeoutMs: number;
  fetchImpl: typeof globalThis.fetch;
  logger?: Logger;
}): Promise<string | null> {
  const send = await fetchImpl(
    `https://2captcha.com/in.php?key=${encodeURIComponent(apiKey)}` +
      `&method=userrecaptcha&googlekey=${encodeURIComponent(sitekey)}` +
      `&pageurl=${encodeURIComponent(pageurl)}&json=1`,
    { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  const sent = (await send.json()) as { status: number | string; request: string };
  if (String(sent.status) !== "1" || !sent.request) {
    logger?.warn("CAPTCHA solver rejected the task.", { detail: sent.request });
    return null;
  }

  const id = String(sent.request);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetchImpl(
      `https://2captcha.com/res.php?key=${encodeURIComponent(apiKey)}&action=get&id=${encodeURIComponent(id)}&json=1`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
    const body = (await res.json()) as { status: number | string; request: string };
    if (String(body.status) === "1" && body.request) return body.request; // the token
    if (body.request !== "CAPCHA_NOT_READY") {
      logger?.warn("CAPTCHA solver returned an error.", { detail: body.request });
      return null;
    }
    if (Date.now() >= deadline) {
      logger?.warn("CAPTCHA solver timed out waiting for a token.", { timeoutMs });
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * Runs IN THE PAGE: drop the token into the response field and fire reCAPTCHA's callback so the
 * page submits itself (falling back to submitting the form directly if no callback is found).
 * Self-contained — puppeteer serializes this function, so it must not close over module scope.
 * DOM is reached through `globalThis as any` because the server tsconfig has no DOM lib.
 */
function injectTokenAndSubmit(token: string): boolean {
  const g = globalThis as any;
  const doc = g.document;
  let fired = false;
  try {
    const nodes = doc.querySelectorAll('textarea#g-recaptcha-response, [name="g-recaptcha-response"]');
    nodes.forEach((el: any) => {
      el.value = token;
      el.innerHTML = token;
      el.style.display = "inline-block";
    });
  } catch {
    /* no response field — carry on and try the callback anyway */
  }
  try {
    const clients = g.window && g.window.___grecaptcha_cfg && g.window.___grecaptcha_cfg.clients;
    if (clients) {
      const walk = (obj: any, depth: number): void => {
        if (!obj || typeof obj !== "object" || depth > 8) return;
        for (const key of Object.keys(obj)) {
          const value = obj[key];
          if (typeof value === "function") {
            try {
              value(token);
              fired = true;
            } catch {
              /* not the callback — keep looking */
            }
          } else if (value && typeof value === "object") {
            walk(value, depth + 1);
          }
        }
      };
      Object.keys(clients).forEach((k) => walk(clients[k], 0));
    }
  } catch {
    /* no reCAPTCHA config — fall through to the form submit */
  }
  if (!fired) {
    try {
      const form = doc.querySelector('form#captcha-form, form[action*="sorry"], form');
      if (form) {
        form.submit();
        fired = true;
      }
    } catch {
      /* nothing to submit */
    }
  }
  return fired;
}

/** Poll until the page leaves `/sorry/` (Google's redirect after a valid solve). */
async function waitOffSorry(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (!/\/sorry\//.test(page.url())) return true;
    } catch {
      // Mid-navigation — treat as "still CAPTCHA" and retry.
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, remaining)));
  }
}
