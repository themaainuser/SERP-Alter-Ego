# SERP Alter Ego

A self-hosted, **SerpApi-compatible** search-results scraper for your own machine. It exposes `GET /search.json` with SerpApi's parameters and response shape for Google **Search, News, Shopping, Images and Finance**, plus a web UI, a **runtime headless-browser toggle**, internal rate limiting and robots.txt handling.

Node.js 20+, Express 5, Cheerio, Puppeteer. No authentication and no user management, by design.

> **Read this first: what is verified and what is not**
>
> | Surface | HTTP mode (headless OFF) | Headless mode (ON) | Verified against live Google? |
> | --- | --- | --- | --- |
> | `google_finance` | yes (static HTML) | yes (all chart windows) | **Yes**: parsed real pages in both modes |
> | `google_news` | yes (Google News RSS feed) | yes (rendered news.google.com) | RSS: **yes**. Rendered page: fixtures only |
> | `google` (web), `google_shopping`, `google_images`, `tbm=nws` | no: Google answers script-less clients with an "enable JavaScript" wall (503 `JS_REQUIRED`) | yes | **No**: parsers are tested against hand-written fixtures only |
>
> The machine this was built on is a datacenter IP and Google served it a CAPTCHA for every SERP request, so the Google Search/Images/Shopping selectors could not be checked against live markup. They anchor on structure rather than obfuscated class names (links wrapping an `<h3>`, `data-attrid`, `/imgres?imgurl=`...), but **expect to adjust them on first real use** (see [Fixing a parser](#fixing-a-parser-when-google-changes-its-markup)). On a residential IP they should be reachable.
>
> **Google's `robots.txt` disallows `/search`**, so with the default `ROBOTS_POLICY=enforce`, Google Search, Images, Shopping and the News tab are refused with `403 ROBOTS_DISALLOWED` (Finance is allowed; the News RSS feed is disallowed too). To use them you must opt in by setting the policy to `warn` or `off`; that is your decision to make, and scraping Google results is against Google's Terms of Service. See [robots.txt policy](#robotstxt-policy).

## Quick start

```bash
npm install
npm run install-browser        # downloads Chrome for headless mode (npm 11 skips Puppeteer's own postinstall)
npm start                      # http://127.0.0.1:3000
```

Open <http://127.0.0.1:3000> for the web UI, or call the API directly:

```bash
curl "http://127.0.0.1:3000/search.json?engine=google_finance&q=GOOGL:NASDAQ"
```

Already have Chrome? Skip `install-browser` and set `CHROME_PATH=/path/to/chrome` (add `CHROME_NO_SANDBOX=true` when running as root or in Docker). Headless mode is never needed for the HTTP-only paths, and Puppeteer is only loaded when a browser is first used.

Configuration comes from environment variables or a `.env` file in the working directory (see [`.env.example`](.env.example)):

```bash
cp .env.example .env
npm start
```

By default the service listens on `127.0.0.1` only. Because there is no authentication, set `HOST=0.0.0.0` only on networks you trust. While bound to loopback, requests with a non-loopback `Host` header are refused (DNS-rebinding protection), and settings changes require a JSON content type.

## Swapping it in for SerpApi

Point your client at this service instead of `https://serpapi.com`; parameters and response shape follow SerpApi's. `api_key` is accepted and ignored (never logged or echoed).

| SerpApi | This service |
| --- | --- |
| `https://serpapi.com/search?engine=google&q=coffee&api_key=KEY` | `http://127.0.0.1:3000/search?engine=google&q=coffee` |
| `/search.json`, `/search.html` | same |
| `/searches/{id}.json`, `/searches/{id}.html` | same (the last 25 searches, in memory) |

Responses include SerpApi's `search_metadata` (`id`, `status`, `json_endpoint`, `created_at`, `processed_at`, `google_url`, `raw_html_file`, `total_time_taken`) and `search_parameters`, then the engine's result keys. Additions that existing clients can ignore: `search_metadata.scraper_mode` (`http`/`headless`), `search_metadata.scraper_fallback`, `search_metadata.robots_txt`, an `error_code` on errors, and `X-Scraper-Mode` / `X-Cache` response headers.

## Endpoints and example calls

All endpoints are `GET /search.json` with `engine=…`. Common parameters: `q`, `hl` (default `en`), `gl` (default `us`), `google_domain` (must be a Google domain), `location` (canonical name, e.g. `Austin, Texas, United States`, sent to Google as `uule`), `num`, `start`, `safe`, `tbs`, `lr`, `cr`, `nfpr`, `filter`, `no_cache`, `output=html`.

```bash
B=http://127.0.0.1:3000

# Google Search: organic_results, knowledge_graph, answer_box, related_questions, related_searches, ads, pagination
curl "$B/search.json?engine=google&q=best+coffee+grinder&num=10&hl=en&gl=us&location=Austin,+Texas,+United+States"

# News: google_news engine (news_results with source, date, iso_date, stories); or the web News tab via tbm=nws
curl "$B/search.json?engine=google_news&q=coffee&gl=us&hl=en"
curl "$B/search.json?engine=google&q=coffee&tbm=nws"
curl "$B/search.json?engine=google_news&topic_token=CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FtVnVHZ0pWVXlnQVAB"

# Shopping: shopping_results with price, extracted_price, old_price, source, rating, reviews, delivery, thumbnail
curl "$B/search.json?engine=google_shopping&q=espresso+machine"
curl "$B/search.json?engine=google&q=espresso+machine&tbm=shop"

# Images: images_results with thumbnail, original, original_width/height, source, title, link; ijn paginates
curl "$B/search.json?engine=google_images&q=coffee&ijn=0"
curl "$B/search.json?engine=google&q=coffee&tbm=isch"

# Finance: summary, graph, knowledge_graph (key_stats + about), news_results, markets, discover_more
curl "$B/search.json?engine=google_finance&q=GOOGL:NASDAQ"
curl "$B/search.json?engine=google_finance&q=BTC-USD"            # currencies, crypto and indexes (.INX:INDEXSP) work too
curl "$B/search.json?engine=google_finance&q=MSFT:NASDAQ&window=1Y"   # summary + graph only; needs headless mode
```

A real Finance response (abridged):

```json
{
  "search_metadata": { "id": "…", "status": "Success", "scraper_mode": "http", "robots_txt": "allowed", "…": "…" },
  "search_parameters": { "engine": "google_finance", "q": "GOOGL:NASDAQ", "hl": "en", "device": "desktop" },
  "summary": {
    "title": "Alphabet Inc Class A", "stock": "GOOGL", "exchange": "NASDAQ",
    "price": "$344.08", "extracted_price": 344.08, "currency": "$",
    "date": "Sep 30, 4:00:01 PM UTC-4",
    "price_movement": { "percentage": 0.93, "value": 3.16, "movement": "Up" },
    "market": { "trading": "Pre-market", "price": "$351.94", "extracted_price": 351.94, "price_movement": { "…": "…" } }
  },
  "graph": [ { "price": 344.27, "currency": "USD", "date": "Sep 30 2026, 09:30 AM UTC-04:00", "volume": 320526 } ],
  "knowledge_graph": { "key_stats": { "stats": [ { "label": "Previous close", "value": "$340.92" } ] }, "about": { "…": "…" } },
  "news_results": [ { "position": 1, "title": "…", "snippet": "…", "source": "TipRanks", "date": "35 minutes ago", "link": "…" } ],
  "markets": { "us": [ { "stock": ".DJI:INDEXDJX", "name": "…", "price": "…", "price_movement": { "…": "…" } } ] },
  "discover_more": [ { "title": "People also search for", "items": [ { "stock": "AMZN:NASDAQ", "…": "…" } ] } ]
}
```

Searches that succeed but find nothing return HTTP 200 with `"error": "Google hasn't returned any results for this query."`, as SerpApi does.

Useful extras: `output=html` (or `/search.html`) returns the raw page that was parsed, `no_cache=true` bypasses the cache, and `headless=true|false` overrides the mode for a single request.

## Headless mode: how it works and how to toggle it

| Mode | What happens | Good for |
| --- | --- | --- |
| **OFF** (HTTP) | A plain HTTP GET (Node's built-in `fetch`) with a browser User-Agent. Fast and light. Google News uses its RSS feed. | Finance (1D), News |
| **ON** (headless) | A shared headless Chrome (Puppeteer) renders the page with JavaScript; each request gets an isolated context, images/fonts/media are not downloaded, and the browser closes after 5 idle minutes or when you switch OFF. | Google Search, Images, Shopping, News tab, Finance chart windows |

**Toggle without restarting**, any of these take effect for the next request (a request already running finishes in the mode it started with):

```bash
# 1. Web UI: the "Headless browser" switch in the header (or Settings)
# 2. API
curl -X PATCH "$B/api/settings" -H 'content-type: application/json' -d '{"headless": true}'
curl "$B/api/settings"
# 3. One request only
curl "$B/search.json?engine=google&q=coffee&headless=true"
# 4. Initial value at startup
HEADLESS=true npm start
```

Changes made through the UI/API are saved to `data/settings.json` and win over environment variables on the next start; `DELETE /api/settings` (or "Reset" in the UI) returns to the environment defaults. Other live settings: `fallbackToHeadless`, `robotsPolicy`, `minIntervalMs`, `cacheTtlSeconds`.

If a search type cannot be served in HTTP mode, the service answers `503 {"error_code": "JS_REQUIRED"}` with an explanation, rather than returning a misleading empty result. Turn on **`fallbackToHeadless`** to have such searches transparently retried in the browser (the response says `"scraper_fallback": true`). It is off by default so that "headless OFF" really means no browser.

## Error handling

Errors use SerpApi's `{"error": "message"}` shape plus an `error_code`, with a meaningful HTTP status and `Retry-After` where relevant.

| Status | `error_code` | When |
| --- | --- | --- |
| 400 | `INVALID_PARAMETER` | Missing `q`, bad `num`/`hl`/`gl`/`google_domain`/…, unsupported `engine` |
| 403 | `ROBOTS_DISALLOWED` | robots.txt disallows the URL and the policy is `enforce` |
| 404 | `NOT_FOUND` | Unknown route or archived search |
| 429 | `UPSTREAM_BLOCKED` | CAPTCHA / HTTP 429 from Google. The host is paused for 5 minutes (`BLOCK_COOLDOWN_MS`); further requests fail fast with `Retry-After` instead of making the block worse |
| 429 | `RATE_LIMITED` | Too many searches queued (`RATE_MAX_QUEUE`) |
| 502 | `UPSTREAM_NETWORK_ERROR`, `UPSTREAM_HTTP_ERROR` | DNS/connection failures, upstream 4xx/5xx (5xx and network errors are retried with backoff first) |
| 502 | `PARSE_ERROR` | The page loaded but its layout was not recognised (never cached) |
| 503 | `JS_REQUIRED`, `BROWSER_UNAVAILABLE`, `CONSENT_REQUIRED`, `ROBOTS_UNAVAILABLE` | See messages; they say what to change |
| 504 | `UPSTREAM_TIMEOUT` | Upstream or page load timed out |

An empty-but-valid results page is **not** an error (HTTP 200 with `error` text), and a page whose layout is unrecognised **is** one, so a Google markup change shows up as `PARSE_ERROR` instead of silently returning nothing.

## Rate limiting

Outbound requests are throttled **per upstream host**: a minimum gap between requests (`RATE_MIN_INTERVAL_MS`, default 2500 ms, plus up to `RATE_JITTER_MS` jitter), `RATE_CONCURRENCY` (default 1) in flight, a bounded queue (`RATE_MAX_QUEUE`) and a wait cap. Transient failures retry with exponential backoff (`HTTP_MAX_RETRIES`, each retry goes back through the limiter). After a CAPTCHA/429 the host enters a cooldown. Identical searches are served from an in-memory cache for `CACHE_TTL_SECONDS` (default 300; `no_cache=true` skips it; failures are never cached). Gap and TTL can be changed live.

These limits protect the IP you are scraping from; they do not make scraping Google risk-free. This project deliberately contains no CAPTCHA solving, proxy rotation or fingerprint spoofing.

## robots.txt policy

Before fetching, the service reads (and caches for an hour) `robots.txt` of the target origin and evaluates it for the user-agent `SerpAlterEgo` (falling back to `*`), following RFC 9309: 4xx means "no rules", while 5xx or an unreachable file means "unavailable".

| `ROBOTS_POLICY` | Disallowed URL | robots.txt unavailable |
| --- | --- | --- |
| `enforce` (default) | `403 ROBOTS_DISALLOWED`, nothing is fetched | `503 ROBOTS_UNAVAILABLE` |
| `warn` | fetched, warning logged, `search_metadata.robots_txt = "disallowed"` | fetched with a warning |
| `off` | robots.txt is not read | not read |

Today `google.com/robots.txt` disallows `/search` (Search, Images, Shopping, News tab) and `news.google.com` disallows its feeds, while `/finance` is allowed. The default therefore makes Finance work out of the box and requires an explicit opt-in (UI Settings, `PATCH /api/settings`, or `ROBOTS_POLICY=warn`) for the rest.

## Architecture

```
src/
  server.js, app.js, config.js, settings.js, logger.js, errors.js
  engines/            one module per engine: validate params -> build URL -> parse   (google, googleNews, googleShopping…, googleFinance)
  parsers/            pure HTML/XML/JSON -> SerpApi structure (unit-tested with fixtures)
  scraper/            rateLimiter, robots, httpFetcher, browser (Puppeteer), guards (CAPTCHA/JS-wall/consent), cache, scraper (orchestration)
  service/            searchService: mode selection, cache, fallback, SerpApi envelope, archive, history
  serpapi/params.js   typed parameter reader, uule encoding
  public/             web UI (vanilla JS, no build step)
```

Admin endpoints used by the UI: `GET /api/status`, `GET /api/history`, `GET|PATCH|DELETE /api/settings`, `GET /health`.

### Fixing a parser when Google changes its markup

1. Reproduce the search and open `search_metadata.raw_html_file` (or call with `output=html`) to get the exact page that was parsed.
2. Save it under `test/fixtures/`, adjust the selectors in `src/parsers/google*.js` until a test against that fixture passes.
3. `npm test`.

## Tests

```bash
npm test
```

Runs on Node's built-in test runner (112 tests, about 20 s): parsers for every search type (Finance and the News RSS use **real captured Google data**, the Google SERP ones synthetic fixtures), the SerpApi endpoints end to end against a fake upstream (parameters, pagination, caching, validation), error cases (5xx + retry, refused connection, timeout, CAPTCHA + cooldown, JS wall, unparseable page, empty results), robots.txt policy, rate limiter, settings, and the **headless toggle**: runtime switching, browser lifecycle, per-request override, in-flight requests, fallback, launch failure, and (when Chrome is installed; otherwise skipped) a real-Chrome test where results only exist after JavaScript runs, so HTTP mode fails with `JS_REQUIRED` and headless mode succeeds.

## Not implemented (on purpose)

Authentication, `async` searches, `/account` and `/locations.json`, `device=mobile|tablet`, sitelinks/rich snippets/top stories/inline videos in web results, Finance `financials`, Google's retired Blog Search (`google_news` covers publishers of every kind; there is no separate blog endpoint), and resolving Google News redirect links (`link` is Google's `news.google.com/rss/articles/…` URL, which redirects to the article).

## Troubleshooting

- **`403 ROBOTS_DISALLOWED`**: expected for Google Search/Images/Shopping/News under the default policy; see above.
- **`503 JS_REQUIRED`**: switch headless ON (or enable the fallback).
- **`503 BROWSER_UNAVAILABLE`**: run `npm run install-browser` or set `CHROME_PATH`; add `CHROME_NO_SANDBOX=true` in Docker/root.
- **`429 UPSTREAM_BLOCKED`**: Google served a CAPTCHA. Wait out the cooldown, raise `RATE_MIN_INTERVAL_MS`, or run once with `BROWSER_HEADFUL=true` and headless ON to solve it by hand in the visible browser (each request uses a fresh profile, so this only helps as a diagnostic).
- **`502 PARSE_ERROR`**: Google's markup changed; see "Fixing a parser".
- Logs go to stderr (`LOG_LEVEL=debug` shows per-phase browser timings; `LOG_FORMAT=json` for log shippers). `api_key` values are redacted.
