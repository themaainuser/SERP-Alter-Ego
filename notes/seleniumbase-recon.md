# SeleniumBase recon — borrowing robustness techniques

Goal (confirmed with Kartik): **fewer Google blocks and CAPTCHAs** for SERP-Alter-Ego.

Source: https://github.com/seleniumbase/SeleniumBase (Python; we are Node/TypeScript + Puppeteer).

Plan note: default is to **borrow techniques into our browser code**, not add a Python
dependency. Running SeleniumBase as a sidecar is out of scope unless Kartik asks for it.

## What to look for in SeleniumBase

1. **How its "undetected" mode hides the fingerprints Chrome leaks** — the tells that let
   Google spot a script driving the browser: the `webdriver` flag, headless-mode giveaways,
   missing browser objects (`navigator.plugins`, `chrome` runtime, etc.).
2. **What it does to avoid getting blocked in the first place** — request patterns, user
   agent / viewport consistency, anything that keeps us from looking like a bot.
3. **What it does when a block still happens** — retry, backoff, proxy, or CAPTCHA-recovery
   behavior.

## Relevant existing code in this repo

- `src/scraper/stealth.ts` + `test/stealth.test.ts` — we already ship some stealth patches.
- `src/scraper/browser.ts` — browser pipeline (capture gate lives here).
- `src/scraper/guards.ts` — block / CAPTCHA page classification.
- `src/scraper/proxy.ts` — proxy support.

---

# Recon findings (2026-10-23)

All claims below were read from SeleniumBase's own docs or source, not second-hand write-ups.

## 1. How UC Mode hides automation fingerprints

UC Mode's three core mechanisms (source: https://github.com/seleniumbase/SeleniumBase/blob/master/help_docs/uc_mode.md):

1. It modifies **chromedriver** to rename the Chrome DevTools Console variables (`cdc_*`
   globals that chromedriver injects and that sites grep for).
2. It **launches Chrome first, then attaches chromedriver**, so the browser never runs with
   chromedriver's bot-shaped settings from birth.
3. It **disconnects chromedriver during stealthy actions** (page loads, clicks) and
   reconnects afterwards, because "while chromedriver is connected, website services can
   detect it".

Honest mapping: all three are **chromedriver/Selenium plumbing problems that Puppeteer does
not have**. Puppeteer injects no `cdc_*` variables and never runs chromedriver. Their newer
"CDP Mode" is explicitly CDP-based — the same protocol Puppeteer already speaks (source:
https://github.com/seleniumbase/SeleniumBase/blob/master/examples/cdp_mode/ReadMe.md).

What does transfer is the underlying doctrine, stated in their 5th-edition deck (source:
https://seleniumbase.io/other/ua_presentation_5.html):

> "CDP alone isn't enough for stealth... the web browser's fingerprint must look like one
> coming from a human-controlled browser. Browsers launched with regular Playwright or
> WebDriver have a poisoned fingerprint."

And on headless (source: https://seleniumbase.io/help_docs/uc_mode):

> "UC Mode is detectable in headless mode" — so their Linux default is a **headed browser on
> Xvfb**, not headless.

## 2. What it does to avoid blocks in the first place

- **Human-like action pacing**: "if automation performs actions too quickly, websites may
  detect this as bot-traffic... space out your actions... random `sleep()` calls can help"
  (source: https://seleniumbase.io/other/ua_presentation_5.html). They also ship a `--slow`
  flag (source: https://seleniumbase.io/help_docs/customizing_test_runs).
- **Fingerprint coherence knobs**: one launch takes `agent` (user-agent), `lang` (locale),
  `tzone` (timezone), `geoloc`, and `platform` together, so the UA, `navigator.language`,
  timezone and geolocation all agree (source: https://seleniumbase.io/help_docs/customizing_test_runs,
  https://github.com/seleniumbase/seleniumbase/blob/master/undetected/cdp_driver/cdp_util.py).
  Example scripts consistently pin `locale="en"` (source: https://github.com/seleniumbase/SeleniumBase/blob/master/help_docs/uc_mode.md).
- **Do Not Track signal** as a first-class launch option (source: https://seleniumbase.io/help_docs/customizing_test_runs).
- **Don't cold deep-link**: their form-submission examples navigate to the page first, type
  and submit, rather than jumping straight to a results URL (source:
  https://github.com/seleniumbase/SeleniumBase/blob/master/help_docs/uc_mode.md).
- **Server fonts**: a default Docker image is missing standard fonts, and "websites can see
  which fonts are installed on your system" — a server tell (source:
  https://seleniumbase.io/other/ua_presentation_5.html, their Dockerfile
  https://github.com/seleniumbase/SeleniumBase/blob/master/Dockerfile).
- **Headed + Xvfb on Linux** rather than headless, for the reasons in section 1 (source:
  https://seleniumbase.io/help_docs/uc_mode).

## 3. What it does when a block still happens

- **Pre-flight probe**: in UC Mode, `driver.get(url)` first runs a cheap plain HTTP
  `requests.get(url)`; if that spots anti-bot protection, it switches to the stealth
  navigation (`uc_open_with_reconnect`) instead of a normal load (source:
  https://github.com/seleniumbase/SeleniumBase/blob/master/help_docs/uc_mode.md).
- **CAPTCHA handling is layered**: `solve_captcha()` covers Cloudflare Turnstile, Friendly
  Captcha, DataDome Slider and Imperva hCaptcha; `uc_gui_click_captcha()` clicks with a real
  OS-level mouse (PyAutoGUI) which needs a headed browser (sources:
  https://seleniumbase.io/other/ua_presentation_5.html, https://seleniumbase.io/help_docs/uc_mode).
  Notably their solver does **not** solve Google image challenges — for Google they recommend
  the human path (source: uc_mode.md, "Choosing the right CAPTCHA service" section).
- **Cooldowns/sleeps between retries** are manual in their examples (`sb.sleep(2..4)` around
  every action).

## What we already do (mapped — do not recommend duplicates)

- `navigator.webdriver` killed by `--disable-blink-features=AutomationControlled`
  (`stealthLaunchArgs()`).
- `window.chrome.runtime` fill + permissions/Notification alignment (`applyStealth()`),
  deliberately no fingerprint fabrication.
- **Human warm search**: homepage → type query → submit, instead of cold deep-linking to
  `/search` (browser.ts `#humanWarmSearch`, on by default via `BROWSER_HUMAN_SEARCH`) — the
  same "don't cold deep-link" doctrine as SeleniumBase.
- **Pacing**: `rateLimiter` spaces per-host requests with jitter; `sleep`-based spacing is
  its core.
- **Headful under Xvfb** is proven working in CI (the CAPTCHA suite runs exactly that way).
- **Block recovery**: `guards.ts` classifies block/CAPTCHA pages, rate limiter pauses the
  host, auto-retry up to 3x, then human-in-loop (headful) or 2captcha (if configured).
- **UA consistency across modes**: HTTP mode, robots fetches and browser mode all send
  `config.userAgent`.

## Borrow candidates for our Puppeteer stack

| # | Technique (SeleniumBase does) | We already have | The gap for us | Size | Value |
|---|---|---|---|---|---|
| 1 | Headed browser on Xvfb is the stealth default; "UC Mode is detectable in headless mode" | Headful mode works (CI proves it), but `BROWSER_HEADFUL` defaults to **false**, so browser mode is headless by default | Make headed+Xvfb the recommended/default path for browser mode on servers (possibly auto-spawn Xvfb when `DISPLAY` is missing), or at least document it as the production setting | small–medium | high |
| 2 | UA / platform / client-hints coherence (`agent`, `lang`, `tzone`, `platform` set together) | One shared UA string for both modes; accept-language per search (`hl`) | `DEFAULT_UA` hardcodes **Windows + Chrome/138** regardless of the real browser: on Linux the UA claims Windows while `navigator.platform` says Linux, and `Sec-CH-UA` client hints likely still report the real Chrome version. Verify, then either derive the UA from the running browser or override the platform/metadata to match | small–medium | high |
| 3 | Verification against a bot-detection battery (they demo browserscan.net / bot.sannysoft.com) | `stealth.test.ts` asserts our patches in isolation | We never measure the *assembled* fingerprint (headless vs headed) against a detection battery. Add local assertions for the invariants (webdriver false, chrome object present, languages consistent, UA vs platform match) and keep one manual live check | small | high (tells us which of the others matter) |
| 4 | Do Not Track launch signal | nothing | Add the DNT/Sec-GPC preference to browser launch; one line, but Google mostly ignores it — value is for other anti-bot layers | tiny | low |
| 5 | Server fonts: install standard fonts where we deploy | deployment-dependent; no Dockerfile in repo | If we ever deploy to a bare Linux/Docker box, missing standard fonts mark us as a server. Deployment note first, action only if we containerize | tiny (docs) | medium on servers |
| 6 | Pre-flight cheap HTTP probe before committing a browser navigation | HTTP mode already runs first and falls back to the browser; rate limiter already pauses a blocked host | Mostly covered; only worth a look if we still burn browser sessions on the URL the HTTP probe already saw blocked | small | low–medium |

Built candidates 1–3 (2026-10-23, approved by Kartik) — plan: `docs/superpowers/plans/2026-10-23-stealth-robustness.md`.
After deploying, eyeball <https://browserscan.net/bot-detection> manually with browser mode — the live check candidate 3 calls for, deliberately kept out of CI.

Explicitly **not** applicable, checked honestly:

- UC Mode's three chromedriver mechanisms (`cdc_*` renaming, attach-after-launch,
  disconnect-during-action): chromedriver-specific; Puppeteer has none of these problems.
- OS-level mouse clicks (`uc_gui_click_captcha` / PyAutoGUI): would mean a new native
  dependency (against the four-runtime-dep policy) and only helps checkbox-only challenges.
  Google's `/sorry/` image challenge needs an actual solve — which our human-in-loop flow and
  2captcha integration already cover; SeleniumBase itself punts Google challenges to humans.
- Their CDP Mode API surface: Puppeteer already *is* a CDP client.

## Status

- [x] Recon of SeleniumBase (done 2026-10-23; sources cited above)
- [x] List of candidate techniques + how each maps to our Puppeteer stack (table above)
- [x] Size the work, get approval before building (approved 2026-10-23 by Kartik — candidates 1–3 built, see the plan linked above)
