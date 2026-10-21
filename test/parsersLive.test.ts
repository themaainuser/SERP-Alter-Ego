import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/fakeUpstream.js';
import { parseGoogleWeb } from '../src/parsers/googleWeb.js';
import { parseSearchNews } from '../src/parsers/googleNews.js';
import { parseShopping } from '../src/parsers/googleShopping.js';
import { parseImages } from '../src/parsers/googleImages.js';

/*
 * Regression net over REAL captured pages (test/fixtures/live/, taken 2026-10-21 via
 * `npm run capture` from a residential IP). The synthetic fixtures in test/fixtures/
 * prove the parsing logic against hand-written markup; these prove that TODAY's live
 * markup still matches what the parsers anchor on. When Google's layout churns and a
 * test here fails, run `npm run verify:live` to see the per-selector coverage gap,
 * re-capture with `npm run capture`, and harden the parser against the new page.
 */

const live = (name: string): string => fixture(`live/${name}`);

describe('parsers against live-captured pages', () => {
  it('keeps full organic coverage on all three live web SERPs', () => {
    for (const file of ['web-coffee.html', 'web-espresso-info.html', 'web-ads.html']) {
      const { data } = parseGoogleWeb(live(file));
      const organic = data.organic_results ?? [];
      assert.ok(organic.length >= 7, `${file}: expected >=7 organic results, got ${organic.length}`);
      assert.ok(
        organic.every((r) => r.title && r.link && r.snippet),
        `${file}: every organic result must carry title, link and snippet`,
      );
      assert.ok(
        organic.every((r) => /^https:\/\//.test(r.link)),
        `${file}: links must be absolute URLs (encrypted /goto kept verbatim for server-side resolution)`,
      );
    }
  });

  it('extracts every unique product from the live shopping grid', () => {
    const { shopping_results } = parseShopping(live('shopping.html'));
    // 15 price-bearing cards on the page, 3 of them same-product re-renders in a second
    // grid section -> 12 unique products; a titleless promo widget is dropped by design.
    assert.equal(shopping_results.length, 12);
    for (const r of shopping_results) {
      assert.ok(r.title, 'title required');
      assert.ok(r.price && r.extracted_price > 0, `${r.title}: price required`);
      assert.ok(r.source, `${r.title}: source required`);
      assert.ok(r.product_id, `${r.title}: product_id (data-cid) required`);
    }
    assert.ok(
      shopping_results.some((r) => r.rating && r.reviews),
      'the grid carries rated products; rating+reviews must parse',
    );
  });

  it('parses every unique destination page of the live images grid', () => {
    const { images_results } = parseImages(live('images.html'));
    // 3 fully-rendered /imgres tiles + 97 unique lazy data-lpage pages (100 tiles, 3 repeats).
    assert.equal(images_results.length, 97);
    assert.ok(
      images_results.every((r) => r.link && r.thumbnail && r.title),
      'every image result must carry link, thumbnail and title',
    );
    assert.ok(images_results.some((r) => r.original), 'the /imgres tiles must keep their original URLs');
  });

  it('parses every story of the live news tab with source and date', () => {
    const { news_results } = parseSearchNews(live('news-tab.html'));
    assert.equal(news_results.length, 10);
    for (const r of news_results) {
      assert.ok(r.title && /^https:\/\//.test(r.link), 'title and absolute link required');
      assert.ok(r.source, `${r.title}: source required`);
      assert.ok(/\bago$|^just now$|^today$|^yesterday$/i.test(r.date ?? ''), `${r.title}: relative date required`);
    }
  });
});
