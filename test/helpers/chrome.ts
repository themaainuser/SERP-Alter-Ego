import fs from 'node:fs';

/** Locate a Chrome/Chromium binary for the real-browser tests, or `undefined` when none is installed. */
export async function findChrome(): Promise<string | undefined> {
  const candidates: Array<string | undefined> = [
    process.env.CHROME_PATH,
    '/usr/local/bin/google-chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  try {
    const { default: puppeteer } = await import('puppeteer');
    candidates.push(await puppeteer.executablePath());
  } catch {
    /* puppeteer not importable */
  }
  return candidates.find((p): p is string => Boolean(p) && fs.existsSync(p as string));
}

export const NO_CHROME_MESSAGE = 'no Chrome/Chromium found (set CHROME_PATH or run `npm run install-browser`)';
