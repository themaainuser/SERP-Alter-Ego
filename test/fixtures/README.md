# Fixtures

Two layers of evidence:

- **`live/`** — full pages captured from live Google on 2026-10-21 through the production stack (`npm run capture`, residential IP). `*.html` is the raw page; `*.json` is the golden parsed output (re-derived offline from the frozen HTML after the 2026-10-21 parser hardening); `manifest.json` records how they were taken. `npm run verify:live` measures parser coverage against them, and `test/parsersLive.test.ts` asserts today's parse in the normal test run. **When a live test fails, the markup has churned: re-capture and harden.**
- **The synthetic files below** — hand-written to prove parsing *logic* (and malformed-input handling) in isolation: exact structures, edge cases, token removal. They prove the parser matches its own assumptions, **not** that live markup still matches — that job belongs to `live/`.

| File | Origin |
| --- | --- |
| `live/web-*.html` | **Real** `google.com/search` pages (queries: `coffee`, `what is espresso`, `buy espresso machine online`), full HTML. |
| `live/shopping.html` | **Real** `google.com/search?tbm=shop` (`udm=28` grid): 12 unique products among 49 `role="listitem"` nodes (refinement chips, promo widgets, same-product re-renders). |
| `live/images.html` | **Real** `google.com/search?tbm=isch`: 3 fully-rendered `/imgres` tiles + 97 unique lazy `data-lpage` tiles. |
| `live/news-tab.html` | **Real** `google.com/search?tbm=nws`: 10 stories, all links encrypted `/goto?url=CAES…` redirects (resolved server-side by the engine). |
| `finance-googl.html` | **Real** `AF_initDataCallback` data blocks captured from `google.com/finance/quote/GOOGL:NASDAQ` (trimmed: only the data scripts, long series shortened). |
| `news-rss-coffee.xml` | **Real** first six items of `news.google.com/rss/search?q=coffee`. |
| `js-wall.html` | Structure of the stub page Google returns to script-less clients (meta refresh to `/httpservice/retry/enablejs`), with tokens removed. |
| `captcha.html` | Structure of Google's `/sorry/` CAPTCHA page, without IP/time details. |
| `web-serp.html`, `web-serp-empty.html`, `news-tab.html`, `news-page.html`, `shopping.html`, `images.html` | **Synthetic**: hand-written to mirror the markup the parsers anchor on (`#rso`, `a > h3`, `data-attrid`, `/imgres?imgurl=`, ...). They prove the parsing logic in isolation. |
