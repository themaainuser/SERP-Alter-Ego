# Contributing

Thanks for helping. Bug reports, parser fixes for Google markup changes, and tests are the most
useful contributions.

## Setup

Node.js 22 or newer.

```bash
npm install
npm run install-browser   # Chrome for headless mode and the real-browser tests
npm test                  # builds the client, then runs every suite
npm run typecheck         # strict TypeScript check of src, test and client
```

Real-Chrome tests are skipped, not failed, when no Chrome is installed.

## Pull requests

- Keep `npm test` and `npm run typecheck` green. CI runs both on every pull request.
- Add or update a test for every behaviour change. Parser changes should come with a fixture
  under `test/fixtures/` (see `test/fixtures/README.md`).
- Match the surrounding style: TypeScript strict mode, ESM imports with `.js` extensions, small
  modules, comments that explain *why*.
- Never commit `.env`, `data/`, `archive/` or a browser profile. Captured fixtures must not contain
  personal data: check them for your location, IP address or account names before committing.

## Reporting security problems

See [SECURITY.md](SECURITY.md). Please do not open public issues for vulnerabilities.
