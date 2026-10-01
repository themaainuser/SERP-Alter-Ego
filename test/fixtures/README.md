# Fixtures

| File | Origin |
| --- | --- |
| `finance-googl.html` | **Real** `AF_initDataCallback` data blocks captured from `google.com/finance/quote/GOOGL:NASDAQ` (trimmed: only the data scripts, long series shortened). |
| `news-rss-coffee.xml` | **Real** first six items of `news.google.com/rss/search?q=coffee`. |
| `js-wall.html` | Structure of the stub page Google returns to script-less clients (meta refresh to `/httpservice/retry/enablejs`), with tokens removed. |
| `captcha.html` | Structure of Google's `/sorry/` CAPTCHA page, without IP/time details. |
| `web-serp.html`, `web-serp-empty.html`, `news-tab.html`, `news-page.html`, `shopping.html`, `images.html` | **Synthetic**: hand-written to mirror the markup the parsers anchor on (`#rso`, `a > h3`, `data-attrid`, `/imgres?imgurl=`, ...). Google's live SERP markup could not be captured from the build environment (Google serves it a CAPTCHA), so these prove the parsing logic, **not** that today's live markup still matches. When Google changes its markup, save a real page with `GET /searches/<id>.html` and add it here. |
