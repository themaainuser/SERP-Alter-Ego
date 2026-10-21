import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer';
import { applyStealth, stealthLaunchArgs, STEALTH_SCRIPT } from '../src/scraper/stealth.js';

const asPage = (o: object) => o as unknown as Page;

describe('stealthLaunchArgs', () => {
  it('adds the AutomationControlled flag when enabled (drops navigator.webdriver)', () => {
    assert.deepEqual(stealthLaunchArgs(true), ['--disable-blink-features=AutomationControlled']);
  });

  it('adds nothing when disabled', () => {
    assert.deepEqual(stealthLaunchArgs(false), []);
  });
});

describe('applyStealth', () => {
  it('injects the script before page scripts when enabled', async () => {
    let injected = '';
    const page = asPage({ evaluateOnNewDocument: async (s: string) => { injected = s; } });
    await applyStealth(page, true);
    assert.ok(injected, 'should have injected a script');
    assert.ok(injected.includes('chrome.runtime'), 'should fill the window.chrome.runtime gap');
    assert.ok(injected.includes('permissions'), 'should align the permission-query gap');
  });

  it('does nothing when disabled', async () => {
    let called = false;
    const page = asPage({ evaluateOnNewDocument: async () => { called = true; } });
    await applyStealth(page, false);
    assert.equal(called, false, 'must not inject when disabled');
  });

  it('never throws when the page cannot take the script (best-effort)', async () => {
    // A page without evaluateOnNewDocument must not abort the render.
    await applyStealth(asPage({}), true);
  });

  it('exposes a runnable, self-contained script', () => {
    // Must not rely on anything outside its own IIFE (it runs before page scripts).
    assert.ok(STEALTH_SCRIPT.trimStart().startsWith('(() => {'));
    assert.ok(STEALTH_SCRIPT.trimEnd().endsWith('})();'));
    // Sanity: it must actually parse as JS.
    assert.doesNotThrow(() => new Function(STEALTH_SCRIPT));
  });
});
