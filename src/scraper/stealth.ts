import type { Page } from "puppeteer";

/**
 * Open-source anti-detection for the browser — the technique `nodriver` applies to Selenium,
 * ported to Puppeteer. It closes the gaps that mark a page as driven by automation so Google
 * issues far fewer challenges in the first place (it *prevents* blocks; it does not *solve* one
 * already served — the human-in-loop CAPTCHA flow still handles those).
 *
 * Deliberately hand-rolled rather than `puppeteer-extra-plugin-stealth`: this project stays
 * dependency-light (four runtime deps) and that plugin lags new Puppeteer majors, which would
 * risk breakage on Puppeteer 25.
 *
 * Applied in two places:
 * - `stealthLaunchArgs()`  → a Chromium flag, browser-wide, that stops `navigator.webdriver`
 *   reporting `true`. This is the single biggest automation signal.
 * - `applyStealth()`       → a script injected before any page script runs, filling the
 *   `window.chrome.runtime` and permission-query gaps that headless/automation leaves open.
 *
 * Everything here is best-effort and must never abort a scrape.
 */

/** Chromium launch args for anti-detection (empty when stealth is disabled). */
export function stealthLaunchArgs(enabled: boolean): string[] {
  return enabled ? ["--disable-blink-features=AutomationControlled"] : [];
}

/** Inject the anti-detection script before any page script runs. Best-effort. */
export async function applyStealth(page: Page, enabled: boolean): Promise<void> {
  if (!enabled) return;
  try {
    await page.evaluateOnNewDocument(STEALTH_SCRIPT);
  } catch {
    // A page/context that can't take the script still scrapes fine — never fail the render.
  }
}

/**
 * Runs in the page before any other script. Keep it cheap, side-effect free and wrapped so a
 * single failure can't break the page. Only fills genuine automation gaps — it does not try to
 * impersonate a specific device or spoof WebGL, which would be fingerprint fabrication.
 */
export const STEALTH_SCRIPT = `(() => {
  // Real Chrome exposes window.chrome (+ runtime); automation often omits it entirely.
  try {
    if (typeof window !== "undefined") {
      if (!window.chrome) window.chrome = {};
      if (!window.chrome.runtime) {
        window.chrome.runtime = { connect: function () {}, sendMessage: function () {}, id: undefined };
      }
    }
  } catch (e) {}

  // Automation answers navigator.permissions.query({name:"notifications"}) inconsistently with
  // Notification.permission (a classic bot tell). Align the two, keeping the real PermissionStatus
  // object (and its prototype) intact so instanceof / listeners still work.
  try {
    var perms = navigator.permissions;
    if (perms && typeof perms.query === "function") {
      var orig = perms.query.bind(perms);
      perms.query = function (desc) {
        return orig(desc).then(function (res) {
          try {
            if (desc && desc.name === "notifications" && typeof Notification !== "undefined") {
              Object.defineProperty(res, "state", {
                get: function () { return Notification.permission; },
                configurable: true,
              });
            }
          } catch (e) {}
          return res;
        });
      };
    }
  } catch (e) {}
})();`;
