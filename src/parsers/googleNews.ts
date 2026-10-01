import * as cheerio from 'cheerio';
import { absoluteUrl, clean, compact, formatNewsDate, parseError, unwrapGoogleRedirect } from './common.js';

const NEWS_BASE = 'https://news.google.com/';

export interface NewsSource {
  name?: string;
  url?: string;
  icon?: string;
}
export interface NewsStory {
  title: string;
  link: string;
  source: { name: string };
}
/** `news_results` entry of `engine=google_news`. */
export interface NewsItem {
  position: number;
  title: string;
  source?: NewsSource;
  link: string;
  thumbnail?: string;
  date?: string;
  iso_date?: string;
  stories?: NewsStory[];
}
/** `news_results` entry of the Google web search News tab (`tbm=nws`). */
export interface TabNewsItem {
  position: number;
  link: string;
  title: string;
  source?: string;
  snippet?: string;
  date?: string;
  thumbnail?: string;
}
export interface NewsParse<T> {
  news_results: T[];
  hasLayout: boolean;
}

/** Parse the news.google.com RSS feed (static XML; used in HTTP mode). */
export function parseNewsRss(xml: string): NewsParse<NewsItem> {
  const $ = cheerio.load(xml, { xmlMode: true });
  if (!$('rss > channel').length) throw parseError('Google News did not return an RSS feed; the feed format may have changed.');

  const results: NewsItem[] = [];
  $('item').each((_, el) => {
    const item = $(el);
    const sourceName = clean(item.find('source').first().text());
    let title = clean(item.children('title').first().text());
    if (sourceName && title.endsWith(` - ${sourceName}`)) title = title.slice(0, -(sourceName.length + 3));
    const link = clean(item.children('link').first().text());
    if (!title || !link) return;
    const pub = new Date(clean(item.children('pubDate').first().text()));

    const stories: NewsStory[] = [];
    const description = cheerio.load(item.children('description').first().text());
    description('li').each((__, li) => {
      const a = description(li).find('a').first();
      const storyLink = clean(a.attr('href'));
      if (!storyLink || storyLink === link) return;
      stories.push({
        title: clean(a.text()),
        link: storyLink,
        source: { name: clean(description(li).find('font').first().text()) },
      });
    });

    results.push(
      compact({
        position: results.length + 1,
        title,
        source: compact({ name: sourceName, url: item.find('source').first().attr('url') }),
        link,
        date: Number.isNaN(pub.getTime()) ? undefined : (formatNewsDate(pub) ?? undefined),
        iso_date: Number.isNaN(pub.getTime()) ? undefined : pub.toISOString(),
        stories,
      }),
    );
  });
  return { news_results: results, hasLayout: true };
}

/** Parse the rendered news.google.com results page (headless mode). */
export function parseNewsPage(html: string): NewsParse<NewsItem> {
  const $ = cheerio.load(html);
  const results: NewsItem[] = [];
  const seen = new Set<string>();
  $('article').each((_, el) => {
    const article = $(el);
    const anchor = article
      .find('a[href]')
      .filter((__, a) => clean($(a).text()).length > 10 && /(^|\/)(read|articles)\//.test($(a).attr('href') ?? ''))
      .first();
    const heading = anchor.length ? anchor : article.find('h3 a, h4 a').first();
    const title = clean(heading.text());
    const link = absoluteUrl(heading.attr('href'), NEWS_BASE);
    if (!title || !link) return;
    const identity = link.split('?')[0] ?? link;
    if (seen.has(identity)) return;
    seen.add(identity);

    const time = article.find('time').first();
    const iso = time.attr('datetime');
    const when = iso ? new Date(iso) : null;
    const sourceName = clean(article.find('[data-n-tid], .vr1PYe, .wEwyrc').first().text());
    const thumbnail = absoluteUrl(article.find('figure img').first().attr('src'), NEWS_BASE);
    const icon = absoluteUrl(article.find('img[src*="favicon"], img.qEdqNd').first().attr('src'), NEWS_BASE);

    results.push(
      compact({
        position: results.length + 1,
        title,
        source: compact({ name: sourceName, icon: icon ?? undefined }),
        link,
        thumbnail: thumbnail && !thumbnail.includes('favicon') ? thumbnail : undefined,
        date: when && !Number.isNaN(when.getTime()) ? (formatNewsDate(when) ?? undefined) : clean(time.text()) || undefined,
        iso_date: when && !Number.isNaN(when.getTime()) ? when.toISOString() : undefined,
      }),
    );
  });
  return { news_results: results, hasLayout: $('c-wiz, main, [role="main"]').length > 0 };
}

/** Parse the "News" tab of a regular Google search (tbm=nws), rendered. */
export function parseSearchNews(html: string, { baseUrl = 'https://www.google.com', start = 0 }: { baseUrl?: string; start?: number } = {}): NewsParse<TabNewsItem> {
  const $ = cheerio.load(html);
  const root = $('#rso').length ? $('#rso') : $('#search');
  const results: TabNewsItem[] = [];
  const seen = new Set<string>();
  root.find('a[href]:has([role="heading"])').each((_, el) => {
    const a = $(el);
    const link = unwrapGoogleRedirect(a.attr('href'), baseUrl);
    const title = clean(a.find('[role="heading"]').first().text());
    if (!link || !title || seen.has(link) || /(^|\.)google\./.test(new URL(link).hostname)) return;
    seen.add(link);

    let card = a.parent();
    for (let i = 0; i < 4 && card.find('a:has([role="heading"])').length <= 1 && card.parent().length; i++) card = card.parent();
    const sourceName = clean(card.find('.CEMjEf span, .NUnG9d span, .MgUUmf span').first().text());
    const snippet = clean(card.find('.GI74Re, .Y3v8qd, .c0cOsd').first().text());
    const date = clean(card.find('.OSrXXb span, .LfVVr, time').first().text());
    const thumbnail = card.find('img').first().attr('src');

    results.push(
      compact({
        position: start + results.length + 1,
        link,
        title,
        source: sourceName,
        snippet,
        date,
        thumbnail: thumbnail && /^(data:|https?:)/.test(thumbnail) ? thumbnail : undefined,
      }),
    );
  });
  return { news_results: results, hasLayout: $('#search, #rso, #main').length > 0 };
}
