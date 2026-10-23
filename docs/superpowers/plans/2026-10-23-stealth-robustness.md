# Stealth Robustness (3 SeleniumBase Borrow Candidates) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce Google blocks/CAPTCHAs by (2) making the browser's identity self-consistent (UA ↔ navigator.platform ↔ client hints), (1) running headed with auto-started Xvfb on Linux, and (3) measuring the assembled fingerprint with a real-Chrome battery.

**Architecture:** Two new small modules — `src/scraper/fingerprint.ts` (parse a UA string into platform + client-hints metadata; apply identity to a page) and `src/scraper/display.ts` (start/stop Xvfb). `browser.ts` swaps its two inline identity lines for the new helper, gains a headed-on-Xvfb launch path with headless fallback, and tracks *effective* headfulness so CAPTCHA escalation messaging stays truthful after a fallback. Tests: pure unit tests where possible, one real-Chrome battery for the assembled result.

**Tech Stack:** Node >= 22, TypeScript (no DOM lib), Puppeteer ^25.12.0, node:test. No new dependencies — `child_process.spawn` is a builtin.

**Spec:** `notes/seleniumbase-recon.md` — candidates 1 (headed+Xvfb), 2 (UA coherence), 3 (measurement battery) in the borrow-candidates table; findings sections carry the source URLs.

## Global Constraints

- No new runtime dependencies (repo policy: four runtime deps).
- Stealth/anti-detection code is best-effort and must never abort a render (house rule from `src/scraper/stealth.ts`).
- `src` builds without the DOM lib: any page-executed script stays a string.
- Tests run as `node --import tsx --test --test-concurrency=1 test/<file>.test.ts`; full suite `npm test` (195 tests currently).
- No visible Chrome windows in normal test runs: `test/helpers/app.ts` pins `BROWSER_HEADFUL=false` once the default flips (the CAPTCHA hydration test overrides it, one window, established norm).
- Changes must pass on Node 22 and 24 (CI matrix) — no Node-24-only APIs.
- Shell is Windows PowerShell 5.1: no heredocs; long commit messages via `git commit -F <file>`.
- Commit messages: plain sentence style, e.g. "Explain the UA before asking questions."-like, no conventional-commit prefixes.

## Review Focus

1. **UA vs client-hints major skew** — a site must never see `Chrome/138` in the UA but `144` in `Sec-CH-UA`. Prevented by deriving metadata *only* from the UA string; Task 1 test pins major equality.
2. **Xvfb process lifecycle** — an orphaned Xvfb holds a display forever. `stop()` must kill the child, be idempotent, run on browser close/disconnect, and a `process.once('exit')` hook covers crashes (Task 4 test asserts kill + double-stop).
3. **Invisible CAPTCHA escalation** — after the Linux headless fallback, branches at `browser.ts:347` and `:361` must use *effective* headfulness, or the operator is told to "solve it in the open browser window" that doesn't exist. Task 4 wires `this.effectiveHeadful`; validation is the captcha suite (7/7) plus typecheck; the fallback path itself never runs on Windows dev or CI (both have DISPLAY or skip), so this branch is reasoned + typed, not executed — note in commit message.
4. **Window popping in dev/CI after the default flip** — `test/helpers/app.ts` must pin `BROWSER_HEADFUL=false` in the same commit that flips the default (Task 3); full suite must show no new windows.
5. **Battery flake risk** — the real-Chrome battery launches Chrome once per `describe` (not per test) and skips cleanly without Chrome (`NO_CHROME_MESSAGE`), so CI without a browser and dev boxes both stay green.

---

### Task 1: UA profile parser

**Files:**
- Create: `src/scraper/fingerprint.ts`
- Test: `test/fingerprint.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 2 and 5):
  ```ts
  export interface UaMetadata { brands: Array<{ brand: string; version: string }>; fullVersionList: Array<{ brand: string; version: string }>; platform: string; platformVersion: string; architecture: string; bitness: string; mobile: boolean; wow64: boolean; }
  export interface UaProfile { navigatorPlatform: string; metadata: UaMetadata; }
  export function parseUaProfile(ua: string): UaProfile | null;
  ```

- [ ] **Step 1: Write the failing tests** (in new `test/fingerprint.test.ts`)

```ts
describe('parseUaProfile', () => {
  it('maps the default Windows desktop UA to a coherent platform and client hints', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
    const p = parseUaProfile(ua);
    assert.ok(p);
    assert.equal(p.navigatorPlatform, 'Win32');
    assert.equal(p.metadata.platform, 'Windows');
    assert.equal(p.metadata.platformVersion, '10.0.0');
    assert.equal(p.metadata.architecture, 'x86');
    assert.equal(p.metadata.bitness, '64');
    assert.equal(p.metadata.mobile, false);
    assert.equal(p.metadata.wow64, false);
    // Client-hints majors must match the UA's claimed major; fullVersionList keeps the full string.
    assert.ok(p.metadata.brands.some((b) => b.brand === 'Google Chrome' && b.version === '138'));
    assert.ok(p.metadata.fullVersionList.some((b) => b.brand === 'Google Chrome' && b.version === '138.0.0.0'));
  });
  it('keeps client-hints majors in step with whatever Chrome version the UA claims', () => {
    const p = parseUaProfile('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.7444.111 Safari/537.36');
    assert.ok(p && p.metadata.brands.every((b) => b.version === '144'));
  });
  it('maps a Linux X11 UA', () => {
    const p = parseUaProfile('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36');
    assert.ok(p);
    assert.equal(p.navigatorPlatform, 'Linux x86_64');
    assert.equal(p.metadata.platform, 'Linux');
    assert.equal(p.metadata.platformVersion, '0.0.0');
  });
  it('maps a macOS UA', () => {
    const p = parseUaProfile('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36');
    assert.ok(p);
    assert.equal(p.navigatorPlatform, 'MacIntel');
    assert.equal(p.metadata.platform, 'macOS');
  });
  it('returns null for a UA it cannot vouch for (no Chrome version)', () => {
    assert.equal(parseUaProfile('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'), null);
    assert.equal(parseUaProfile(''), null);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --import tsx --test --test-concurrency=1 test/fingerprint.test.ts`
Expected: FAIL — module `../src/scraper/fingerprint.js` not found.

- [ ] **Step 3: Implement `parseUaProfile(ua: string): UaProfile | null` in `src/scraper/fingerprint.ts`**

Define `UaMetadata`/`UaProfile` exactly as in the Interfaces block (a local structural type — do not import the CDP protocol tree). Mapping decisions: Windows → `navigatorPlatform: "Win32"`, `platformVersion` from `Windows NT x.y` padded to `"x.y.0"`, `architecture "x86"`, `bitness "64"` when the UA says `Win64; x64` else `"32"`; Linux → `"Linux x86_64"` / `"Linux"` / `"0.0.0"` / x86/64; macOS → `"MacIntel"` / `"macOS"` / `"13.0.0"` (UA-CH platform version is not derivable from the frozen `10_15_7` token; a stable placeholder keeps JS view and headers mutually consistent). Brands: `Google Chrome`, `Chromium`, and grease brand `Not_A Brand` version `99`, major and full version taken from `Chrome/<full>`; `mobile: false`, `wow64: false`. No `Chrome/<digits>` match → return `null`. Doc-comment the WHY (client-hints coherence, sourced from the recon).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test --test-concurrency=1 test/fingerprint.test.ts`
Expected: 5 pass, 0 fail.

- [ ] **Step 5: Commit**

```powershell
git add src/scraper/fingerprint.ts test/fingerprint.test.ts
git commit -m "Parse a browser UA into the platform and client hints that agree with it"
```

---

### Task 2: Apply the identity to a page, wire it into render()

**Files:**
- Modify: `src/scraper/fingerprint.ts` (add `applyPageIdentity`)
- Modify: `src/scraper/browser.ts:260-261` (replace the two inline identity lines)
- Test: `test/fingerprint.test.ts` (extend)

**Interfaces:**
- Consumes: `parseUaProfile` (Task 1).
- Produces (consumed by Task 5):
  ```ts
  export async function applyPageIdentity(page: Page, opts: { userAgent: string; acceptLanguage: string }): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests** (new `describe('applyPageIdentity')` in `test/fingerprint.test.ts`; fake-page pattern from `test/stealth.test.ts`)

```ts
describe('applyPageIdentity', () => {
  it('sets the UA together with a matching platform, client hints and accept-language', async () => {
    let uaOpts: Record<string, unknown> = {}; let headers: Record<string, string> = {};
    const page = {
      setUserAgent: async (o: Record<string, unknown>) => { uaOpts = o; },
      setExtraHTTPHeaders: async (h: Record<string, string>) => { headers = h; },
    } as unknown as Page;
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
    await applyPageIdentity(page, { userAgent: ua, acceptLanguage: 'de,en;q=0.8' });
    assert.equal(uaOpts.userAgent, ua);
    assert.equal(uaOpts.acceptLanguage, 'de,en;q=0.8');
    assert.equal(uaOpts.platform, 'Win32');
    assert.ok((uaOpts.userAgentMetadata as { platform: string }).platform === 'Windows');
    assert.deepEqual(headers, { 'accept-language': 'de,en;q=0.8' });
  });
  it('leaves platform and metadata unset when the UA cannot be parsed', async () => {
    let uaOpts: Record<string, unknown> = {};
    const page = { setUserAgent: async (o: Record<string, unknown>) => { uaOpts = o; }, setExtraHTTPHeaders: async () => {} } as unknown as Page;
    await applyPageIdentity(page, { userAgent: 'SomethingOdd/1.0', acceptLanguage: 'en-US,en;q=0.9' });
    assert.equal('platform' in uaOpts, false);
    assert.equal('userAgentMetadata' in uaOpts, false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --import tsx --test --test-concurrency=1 test/fingerprint.test.ts`
Expected: FAIL — `applyPageIdentity` is not exported.

- [ ] **Step 3: Implement `applyPageIdentity` and wire it into render()**

In `fingerprint.ts`: call `page.setUserAgent` with `userAgent`, `acceptLanguage`, and — only when `parseUaProfile` returned a profile — `platform` and `userAgentMetadata`; then `page.setExtraHTTPHeaders({ "accept-language": acceptLanguage })` (kept because engines rely on the header form today). In `browser.ts` replace lines 260-261 with one `applyPageIdentity` call passing `{ userAgent: userAgent || this.config.userAgent, acceptLanguage }`, and update the import list on line 11's neighborhood to include it.

- [ ] **Step 4: Run tests + typecheck**

Run: `node --import tsx --test --test-concurrency=1 test/fingerprint.test.ts` then `npm run typecheck`
Expected: 7 pass, 0 fail; typecheck clean.

- [ ] **Step 5: Commit**

```powershell
git add src/scraper/fingerprint.ts src/scraper/browser.ts test/fingerprint.test.ts
git commit -m "Give the browser page one identity: UA, platform and client hints from the same string"
```

---

### Task 3: Headed-by-default with a pinned test env

**Files:**
- Modify: `src/config.ts:81` (`headful: bool(env.BROWSER_HEADFUL, false)` → `true`)
- Modify: `test/helpers/app.ts` (default env block, ~line 37, gains `BROWSER_HEADFUL: 'false'`)
- Test: `test/infrastructure.test.ts` (misc units describe, ~line 206)

**Interfaces:**
- Consumes: nothing.
- Produces: `config.browser.headful === true` by default; the CAPTCHA hydration test keeps overriding via its own `env` (spreads after defaults in `startApp`, verified).

- [ ] **Step 1: Write the failing test** (in `test/infrastructure.test.ts` misc units)

```ts
it('runs the browser headed by default (stealth), overridable by env', () => {
  assert.equal(loadConfig({}).browser.headful, true);
  assert.equal(loadConfig({ BROWSER_HEADFUL: 'false' }).browser.headful, false);
});
```

(`loadConfig` is already imported in this file — verify at line 15.)

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test --test-concurrency=1 --test-name-pattern "headed by default" test/infrastructure.test.ts`
Expected: FAIL — default is still `false`.

- [ ] **Step 3: Flip the default and pin the test env**

`src/config.ts:81`: `headful: bool(env.BROWSER_HEADFUL, true)`. In `test/helpers/app.ts`, add `BROWSER_HEADFUL: 'false',` to the default env object (before the `...env` spread so tests can override). Rationale comment in config: SeleniumBase's docs state automation is detectable in headless mode; headed+Xvfb is the stealth path, and `display.ts` provides the Xvfb fallback.

- [ ] **Step 4: Run tests**

Run: `node --import tsx --test --test-concurrency=1 --test-name-pattern "headed by default" test/infrastructure.test.ts` then the full `npm test`
Expected: targeted PASS; full suite green with **no new browser windows** (helper pinning verified by eye — same as before this change).

- [ ] **Step 5: Commit**

```powershell
git add src/config.ts test/helpers/app.ts test/infrastructure.test.ts
git commit -m "Run the browser headed by default, keeping tests on the headless path"
```

---

### Task 4: Xvfb auto-start on Linux with headless fallback

**Files:**
- Create: `src/scraper/display.ts`
- Modify: `src/scraper/browser.ts` — `#ensureBrowser` (~line 142-160), `BrowserManager` fields, the `disconnected` handler (165-168), `close()` (the method logging "Closing headless browser" ~549), and the CAPTCHA escalation branches at ~347 and ~361.
- Test: `test/display.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces (consumed by browser.ts):
  ```ts
  export interface DisplaySession { display: string; env: { DISPLAY: string }; stop(): void; }
  export function startXvfb(opts?: { spawn?: SpawnLike; timeoutMs?: number }): Promise<DisplaySession | null>;
  export type SpawnLike = (command: string, args: readonly string[], options: { stdio: ['ignore', 'pipe', 'pipe'] }) => ChildProcess;
  ```

- [ ] **Step 1: Write the failing tests** (new `test/display.test.ts`)

```ts
describe('startXvfb', () => {
  it('resolves a session for the display Xvfb reports on stdout', async () => { /* fake spawn: PassThrough stdout writes ':77\\n' after a tick → session.display === ':77', env.DISPLAY === ':77' */ });
  it('resolves null when the binary is missing (ENOENT error event)', async () => { /* fake spawn child emits error → null */ });
  it('resolves null and kills the child when Xvfb never reports a display (timeout)', async () => { /* timeoutMs: 30; child.killed eventually true */ });
  it('stop() kills the child and is safe to call twice', async () => { /* session.stop(); session.stop(); child.killed true, no throw */ });
  it('works with the real Xvfb when one exists (CI/Linux), returns null on machines without it', async () => {
    const s = await startXvfb();
    if (s === null) return; // dev Windows: absence is a valid outcome
    assert.match(s.display, /^:\d+$/);
    s.stop();
  });
});
```

Fake spawn = function returning a hybrid `EventEmitter` + `PassThrough` stdout cast to `ChildProcess` with a `kill()` flag.

- [ ] **Step 2: Run to verify they fail**

Run: `node --import tsx --test --test-concurrency=1 test/display.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `startXvfb` in `src/scraper/display.ts`**

Spawn `Xvfb` with `['-displayfd', '1', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp']`; parse the first stdout line matching `/^:\d+$/m` as the display; a `timeoutMs` (default 5000) timer kills the child and resolves `null`; an `error` event (ENOENT) resolves `null`; `stop()` kills the child idempotently and removes the `process.once('exit', …)` kill hook. `child.unref()` so Xvfb never keeps Node alive. Doc-comment WHY (headed browser on servers, sourced from the recon).

- [ ] **Step 4: Run to verify they pass**

Run: `node --import tsx --test --test-concurrency=1 test/display.test.ts`
Expected: 5 pass, 0 fail (the real-Xvfb test is the null path on Windows dev).

- [ ] **Step 5: Wire into `browser.ts` (no new test; verified by Step 6)**

In `#ensureBrowser`, before the launcher call: when `cfg.headful && process.platform === 'linux' && !process.env.DISPLAY`, `const session = await startXvfb()`; on success store it on a new private field, pass `env: { ...process.env, ...session.env }` into the launcher options (spread-conditional, absent otherwise), and log `Started Xvfb for a headed browser` with the display; on `null` log the fallback warning and set the effective headless flag true. Track `private effectiveHeadful: boolean | null` (null = not launched → falls back to `cfg.headful`); pass `headless: !(this.effectiveHeadful ?? !cfg.headful)` … concretely: compute `const headful = this.effectiveHeadful ?? cfg.headful` once per launch, use it for both the launcher's `headless` and the fallback assignment. Stop the session in the `disconnected` handler and in `close()` (both places must null the field so a later relaunch respawns Xvfb). Update the `"Headless browser launched"` log to include `{ headless }`. In the CAPTCHA escalation branches (~347, ~361), replace `cfg.headful` with `const visible = this.effectiveHeadful ?? cfg.headful` so a fallback run never asks a human to solve an invisible CAPTCHA.

- [ ] **Step 6: Verify**

Run: `npm run typecheck` then `node --import tsx --test --test-concurrency=1 test/captcha.test.ts test/display.test.ts`
Expected: typecheck clean; captcha 7/7 (one window — the established headful hydration test) and display 5/5.

- [ ] **Step 7: Commit**

```powershell
git add src/scraper/display.ts src/scraper/browser.ts test/display.test.ts
git commit -m "Auto-start Xvfb so the headed browser can run on headless Linux, falling back cleanly"
```

---

### Task 5: Real-Chrome fingerprint battery + docs

**Files:**
- Test: `test/stealth.test.ts` (extend with a real-Chrome describe)
- Modify: `notes/seleniumbase-recon.md` (status checklist + manual live-check note)

**Interfaces:**
- Consumes: `applyPageIdentity` (Task 2), `stealthLaunchArgs`/`applyStealth` (existing), `findChrome`/`NO_CHROME_MESSAGE` from `test/helpers/chrome.ts`, `listenSafe` from `test/helpers/safePort.ts`.

- [ ] **Step 1: Write the battery** (new describe; launch one Chrome in a `before`, close in an `after`)

```ts
describe('browser fingerprint battery (real Chrome)', { skip: chrome ? false : NO_CHROME_MESSAGE }, () => {
  // before(): puppeteer.launch({ executablePath: chrome, headless: true, args: [...stealthLaunchArgs(true), '--no-first-run', '--disable-dev-shm-usage'] })
  // Each test navigates via applyPageIdentity + applyStealth on a fresh page to a local
  // http server (inline http.createServer + listenSafe) that records request headers.
  it('does not leak webdriver and exposes window.chrome.runtime', async () => {
    // assert: (await page.evaluate('() => [typeof navigator.webdriver, navigator.webdriver]'))[0] !== 'true' value not true
    // assert: chrome.runtime.connect is a function
  });
  it('matches UA, platform and languages to the configured identity', async () => {
    // identity: UA = the Windows 138 string (local const), acceptLanguage 'en-US,en;q=0.9'
    // assert navigator.userAgent === ua; navigator.platform === 'Win32';
    // navigator.languages[0] === 'en-US'; navigator.userAgentData.platform === 'Windows'
  });
  it('sends client-hints headers that agree with the configured UA', async () => {
    // server-captured request headers:
    // 'sec-ch-ua-platform' === '"Windows"'; 'sec-ch-ua-mobile' === '?0';
    // 'sec-ch-ua' contains '"Google Chrome"' and '"138"'
  });
});
```

- [ ] **Step 2: Run to verify**

Run: `node --import tsx --test --test-concurrency=1 test/stealth.test.ts`
Expected: existing 7 fake-page tests + battery (3) pass on a dev box with Chrome; battery cleanly `# SKIP`ped without one.

- [ ] **Step 3: Update the recon notes**

In `notes/seleniumbase-recon.md`: mark the approval checkbox done ("built: candidates 1-3, see docs/superpowers/plans/2026-10-23-stealth-robustness.md"), and add one line under candidate 3: after deploying, eyeball `https://browserscan.net/bot-detection` manually with browser mode — a live check we deliberately keep out of CI.

- [ ] **Step 4: Commit**

```powershell
git add test/stealth.test.ts notes/seleniumbase-recon.md
git commit -m "Measure the assembled browser fingerprint against a real Chrome"
```

---

### Task 6: Full validation

- [ ] **Step 1:** `npm run typecheck` — clean.
- [ ] **Step 2:** `npm test` — full suite green (one headful window from the captcha hydration test, same as today).
- [ ] **Step 3:** Node 22 spot-check of new tests: `$n22 --import tsx --test --test-concurrency=1 test/fingerprint.test.ts test/display.test.ts test/stealth.test.ts` (binary at `%TEMP%\node22\node-v22.23.4-win-x64\node.exe`) — green.
- [ ] **Step 4:** Push and watch CI (both matrix jobs) to green; report.
