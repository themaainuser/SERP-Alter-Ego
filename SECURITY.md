# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Use GitHub's private
vulnerability reporting instead (the repository's **Security** tab → **Report a vulnerability**).
Include the version or commit, how to reproduce it, and what an attacker gains. You should get a
first response within a week.

## Threat model

SERP Alter Ego is a **single-user tool for your own machine**. It has no authentication, by design.
The protections below assume that, and so should any report.

| Boundary | What protects it |
| --- | --- |
| Other machines on the network | The server listens on `127.0.0.1` by default. Setting `HOST=0.0.0.0` exposes searches, history and settings to anyone who can reach the port; the server logs a warning when you do. |
| Web pages open in your browser | While bound to loopback, requests whose `Host` header is not a loopback name are refused (DNS rebinding). Cross-site requests that are not a visible top-level navigation (`<img>`, `fetch`, hidden `<iframe>`) are refused using the `Sec-Fetch-*` headers. Settings changes need a JSON body, which a cross-site page cannot send without a CORS preflight, and the service sends no CORS headers, so the browser never lets it through. |
| Scraped Google HTML | The web UI renders results with `textContent` and allowlisted `http(s)` links only. Raw pages (`/searches/<id>.html`, `output=html`) are served under a CSP without `script-src`, so Google's scripts never run in the service's origin; the UI frames them in a sandbox without `allow-scripts`. |
| Outbound requests (SSRF) | `google_domain` must be a Google domain (`google.com`, `google.cat`, `google.<cc>`, `google.co.<cc>`, `google.com.<cc>`). Result links are fetched server-side only when they are Google `/goto` redirects on a Google host, and `/goto?url=` only accepts an opaque token that is forwarded to Google's own `/goto`. |
| Secrets | `PROXY_URL` credentials are redacted in logs. `api_key` query parameters are never echoed and are redacted in logs. `CAPTCHA_SOLVER_API_KEY` is only sent to the solver you configured. |

## Things to keep in mind

- A persistent browser profile (`CHROME_USER_DATA_DIR`) holds real cookies and logins. Use a
  dedicated profile, not your everyday one, and never commit it.
- `ROBOTS_POLICY=warn|off`, `PROXY_URL` and `CAPTCHA_SOLVER` are opt-in. Scraping Google is
  against Google's Terms of Service; you are responsible for how you use this tool.
