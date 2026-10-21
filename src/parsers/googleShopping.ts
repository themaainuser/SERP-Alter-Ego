import * as cheerio from 'cheerio';
import { absoluteUrl, clean, compact, findPrice, isGoogleHost, parseError, type Selection, textLines, unwrapGoogleRedirect } from './common.js';

const CARD_SELECTORS = [
  '[data-docid]',
  '.sh-dgr__grid-result',
  '.sh-dlr__list-result',
  '.i0X6df',
  '.KZmu8e',
  '.LrTUQ',
].join(', ');

/** `shopping_results` entry. */
export interface ShoppingResult {
  position: number;
  title: string;
  link?: string;
  product_link?: string;
  product_id?: string;
  source?: string;
  price: string;
  extracted_price: number;
  old_price?: string;
  extracted_old_price?: number;
  rating?: number;
  reviews?: number;
  tag?: string;
  delivery?: string;
  thumbnail?: string;
}

const DELIVERY_RE = /(free (delivery|shipping)|delivery|shipping|pickup|in stock)/i;
const TAG_RE = /^(\d{1,2}% off|sale|best price|top rated|low price|new)$/i;

function parseRating(card: Selection, lines: string[]): { rating?: number; reviews?: number } {
  const labelled = card.find('[aria-label*="out of 5"], [aria-label*="stars"], [aria-label*="Rated"]').first().attr('aria-label') || '';
  const fromLabel = /(\d(?:[.,]\d)?)\s*(?:out of 5|stars)/i.exec(labelled);
  const reviewsFromLabel = /([\d.,KkMm]+)\s*(?:reviews?|ratings?)/i.exec(labelled);
  let rating = fromLabel ? Number(fromLabel[1].replace(',', '.')) : undefined;
  let reviews = reviewsFromLabel ? reviewsFromLabel[1] : undefined;
  if (rating === undefined) {
    const idx = lines.findIndex((l) => /^[0-5](?:[.,]\d)?$/.test(l));
    if (idx > -1) {
      rating = Number(lines[idx].replace(',', '.'));
      const next = lines[idx + 1] || '';
      const m = /^\(?([\d.,KkMm]+)\)?$/.exec(next);
      if (m) reviews = m[1];
    }
  }
  return { rating, reviews: reviews ? parseReviews(reviews) : undefined };
}

function parseReviews(s: string): number | undefined {
  const m = /^([\d.,]+)([KkMm])?$/.exec(s.replace(/[()]/g, ''));
  if (!m) return undefined;
  const base = Number(m[1].replace(/,/g, ''));
  const mult = { k: 1e3, m: 1e6 }[(m[2] || '').toLowerCase()] ?? 1;
  return Math.round(base * mult);
}

/** Parse a rendered Google Shopping results page into SerpApi-style `shopping_results`. */
export function parseShopping(html: string, { baseUrl = 'https://www.google.com' }: { baseUrl?: string } = {}): { shopping_results: ShoppingResult[]; hasLayout: boolean } {
  const $ = cheerio.load(html);
  const hasLayout = $('#search, #rso, #main, #center_col, [data-docid]').length > 0;

  const cards = $(CARD_SELECTORS).filter((_, el) => !$(el).parents(CARD_SELECTORS).length);
  const results: ShoppingResult[] = [];
  const seen = new Set<string>();

  cards.each((_, el) => {
    const card = $(el);
    const lines = textLines(card);
    const priceLine = lines.find((l) => findPrice(l));
    const price = priceLine ? findPrice(priceLine) : null;
    const heading = clean(card.find('[role="heading"], h3, h4, .tAxDx, .EI11Pd, .rgHvZc').first().text());
    const title = heading || lines.find((l) => l.length > 12 && !findPrice(l) && !DELIVERY_RE.test(l)) || '';
    if (!title || !price) return;

    const struck = card.find('s, del, [style*="line-through"]').first().text();
    const oldPrice = struck ? findPrice(struck) : null;
    const anchors = card.find('a[href]').toArray().map((a) => $(a).attr('href'));
    const productHref = anchors.find((h) => /\/(shopping\/product|product)\//.test(h || '') || /[?&]prds=/.test(h || ''));
    const merchantHref = anchors
      .map((h) => unwrapGoogleRedirect(h, baseUrl))
      .find((h) => h && !isGoogleHost(new URL(h).hostname));
    const productLink = absoluteUrl(productHref, baseUrl) || absoluteUrl(anchors.find(Boolean), baseUrl);
    const link = merchantHref || productLink;
    const key = `${title}|${price.price}|${link}`;
    if (seen.has(key)) return;
    seen.add(key);

    const priceIdx = priceLine ? lines.indexOf(priceLine) : -1;
    const sourceNode = clean(card.find('.aULzUe, .IuHnof, .E5ocAb, .WJMUdc, .dD8iuc .zPEcBd').first().text());
    const source =
      sourceNode ||
      lines.slice(priceIdx + 1).find((l) => l.length > 1 && l.length < 40 && !findPrice(l) && !DELIVERY_RE.test(l) && !/^[0-5](?:[.,]\d)?$/.test(l) && !/^\(?[\d.,KkMm]+\)?$/.test(l) && !TAG_RE.test(l));
    const { rating, reviews } = parseRating(card, lines);
    const img = card.find('img').first().attr('src');
    const docId = card.attr('data-docid');

    results.push(
      compact({
        position: results.length + 1,
        title,
        link: link ?? undefined,
        product_link: productLink ?? undefined,
        product_id: docId,
        source,
        price: price.price,
        extracted_price: price.extracted_price,
        old_price: oldPrice?.price,
        extracted_old_price: oldPrice?.extracted_price,
        rating,
        reviews,
        tag: lines.find((l) => TAG_RE.test(l)),
        delivery: lines.find((l) => DELIVERY_RE.test(l) && l.length < 60),
        thumbnail: img && /^(data:|https?:)/.test(img) ? img : undefined,
      }),
    );
  });

  if (!results.length && !hasLayout) {
    throw parseError('Google Shopping page was not recognised (no product grid found); the layout may have changed or the page did not finish rendering.');
  }
  return { shopping_results: results, hasLayout };
}
