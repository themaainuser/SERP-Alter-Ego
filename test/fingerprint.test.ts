import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseUaProfile } from '../src/scraper/fingerprint.js';

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
    assert.ok(p);
    // The grease brand deliberately carries its own version (real Chrome does the same),
    // so only the Chrome brands are compared against the UA's major.
    const chromeBrands = p.metadata.brands.filter((b) => b.brand === 'Google Chrome' || b.brand === 'Chromium');
    assert.ok(chromeBrands.length > 0);
    assert.ok(chromeBrands.every((b) => b.version === '144'));
    assert.ok(p.metadata.fullVersionList.some((b) => b.brand === 'Google Chrome' && b.version === '144.0.7444.111'));
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
