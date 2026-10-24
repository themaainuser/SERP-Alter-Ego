import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { type DisplaySession, type SpawnLike, startXvfb } from '../src/scraper/display.js';
import { BrowserManager, type BrowserLauncher } from '../src/scraper/browser.js';
import { loadConfig } from '../src/config.js';

/** A ChildProcess stand-in: EventEmitter + PassThrough stdout + a kill() flag. */
function fakeChild() {
  const stdout = new PassThrough();
  let killed = false;
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    readonly killed: boolean;
    kill(): boolean;
    unref(): unknown;
  };
  child.stdout = stdout;
  Object.defineProperty(child, 'killed', { get: () => killed });
  child.kill = () => { killed = true; return true; };
  child.unref = () => child;
  return child;
}

describe('startXvfb', () => {
  it('resolves a session for the display Xvfb reports on stdout', async () => {
    const child = fakeChild();
    const spawn = (() => {
      queueMicrotask(() => child.stdout.write(':77\n'));
      return child;
    }) as unknown as SpawnLike;
    const session = await startXvfb({ spawn });
    assert.ok(session);
    assert.equal(session.display, ':77');
    assert.equal(session.env.DISPLAY, ':77');
    session.stop();
    assert.equal(child.killed, true, 'stopping the session kills Xvfb');
  });

  it('resolves null when the binary is missing (ENOENT error event)', async () => {
    const child = fakeChild();
    const spawn = (() => {
      queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn Xvfb ENOENT'), { code: 'ENOENT' })));
      return child;
    }) as unknown as SpawnLike;
    assert.equal(await startXvfb({ spawn }), null);
  });

  it('resolves null and kills the child when Xvfb never reports a display (timeout)', async () => {
    const child = fakeChild();
    const spawn = (() => child) as unknown as SpawnLike;
    assert.equal(await startXvfb({ spawn, timeoutMs: 30 }), null);
    assert.equal(child.killed, true, 'a hung Xvfb is killed, not leaked');
  });

  it('stop() kills the child and is safe to call twice', async () => {
    const child = fakeChild();
    const spawn = (() => {
      queueMicrotask(() => child.stdout.write(':78\n'));
      return child;
    }) as unknown as SpawnLike;
    const session = await startXvfb({ spawn });
    assert.ok(session);
    session.stop();
    session.stop(); // idempotent — close() and the disconnect handler may both call it
    assert.equal(child.killed, true);
  });

  it('works with the real Xvfb when one exists (CI/Linux), returns null on machines without it', async () => {
    const session = await startXvfb();
    if (session === null) return; // dev Windows: absence is a valid outcome
    assert.match(session.display, /^:\d+$/);
    session.stop();
  });
});

/** Synthetic DisplaySession that records whether stop() was called. */
function fakeDisplaySession() {
  let stopped = false;
  const session: DisplaySession = {
    display: ':99',
    env: { DISPLAY: ':99' },
    stop: () => { stopped = true; },
  };
  return { session, wasStopped: () => stopped };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * A launcher like test/helpers/app.ts's fakeLauncher, plus two lifecycle controls:
 * `gate` holds browser.close() open until resolved, and each browser's "disconnected"
 * handlers are captured per-launch so a test can fire an OLD browser's disconnect by hand.
 */
function lifecycleLauncher(opts: { gate?: Promise<void>; failFirst?: boolean } = {}) {
  const instances: Array<{ disconnect(): void }> = [];
  let launches = 0;
  const launcher = async () => {
    launches += 1;
    if (opts.failFirst && launches === 1) throw new Error('simulated launch failure');
    const newContext = async () => ({
      async newPage() {
        let current = '';
        return {
          setUserAgent: async () => {},
          setExtraHTTPHeaders: async () => {},
          setCookie: async () => {},
          setRequestInterception: async () => {},
          evaluateOnNewDocument: async () => {},
          on() {},
          off() {},
          goto: async (url: string) => {
            current = url;
            return { status: () => 200 };
          },
          waitForSelector: async () => {},
          waitForFunction: async () => {},
          waitForNetworkIdle: async () => {},
          url: () => current,
          content: async () => '<html><body>ok</body></html>',
          evaluate: async () => false,
          close: async () => {},
        };
      },
      close: async () => {},
    });
    let connected = true;
    const handlers: Array<() => void> = [];
    instances.push({ disconnect: () => handlers.forEach((h) => h()) });
    return {
      get connected() {
        return connected;
      },
      on(_event: string, handler: () => void) {
        handlers.push(handler);
      },
      process: () => null,
      async createBrowserContext() {
        return newContext();
      },
      async defaultBrowserContext() {
        return newContext();
      },
      async close() {
        connected = false;
        if (opts.gate) await opts.gate;
      },
    };
  };
  return { launcher: launcher as unknown as BrowserLauncher, instances, launches: () => launches };
}

describe('BrowserManager display lifecycle', () => {
  const headfulConfig = () => loadConfig({ NODE_ENV: 'test', BROWSER_HEADFUL: 'true' });

  it('keeps the process exit hook for the whole session and removes it on stop', async () => {
    const child = fakeChild();
    const spawn = (() => {
      queueMicrotask(() => child.stdout.write(':51\n'));
      return child;
    }) as unknown as SpawnLike;
    const before = process.listenerCount('exit');
    const session = await startXvfb({ spawn });
    assert.ok(session);
    assert.equal(process.listenerCount('exit'), before + 1, 'the exit hook stays for the session lifetime');
    session.stop();
    assert.equal(process.listenerCount('exit'), before, 'stop() removes the exit hook');
  });

  it('stops the started display when the browser launch fails, and a retry starts a fresh one', async () => {
    const { launcher } = lifecycleLauncher({ failFirst: true });
    const displays: Array<ReturnType<typeof fakeDisplaySession>> = [];
    const startDisplay = async () => {
      const d = fakeDisplaySession();
      displays.push(d);
      return d.session;
    };
    const manager = new BrowserManager({
      config: headfulConfig(),
      launcher,
      startDisplay,
      needsDisplay: () => true,
    });

    await assert.rejects(manager.render('http://x.test/'), /Could not start/);
    assert.equal(displays.length, 1);
    assert.equal(displays[0].wasStopped(), true, 'a failed launch must not leave the display running');

    const page = await manager.render('http://y.test/');
    assert.equal(page.url, 'http://y.test/');
    assert.equal(displays.length, 2, 'the retry starts a fresh display');
    assert.equal(displays[1].wasStopped(), false);
    await manager.close();
    assert.equal(displays[1].wasStopped(), true, 'close() stops the display');
  });

  it('a stale close and its disconnect never stop a newer browser display', async () => {
    const gate = deferred();
    const { launcher, instances } = lifecycleLauncher({ gate: gate.promise });
    const displays: Array<ReturnType<typeof fakeDisplaySession>> = [];
    const startDisplay = async () => {
      const d = fakeDisplaySession();
      displays.push(d);
      return d.session;
    };
    const manager = new BrowserManager({
      config: headfulConfig(),
      launcher,
      startDisplay,
      needsDisplay: () => true,
    });

    assert.ok(await manager.render('http://x.test/'));
    const firstClose = manager.close(); // in flight: held open by the gate
    // A render while close() still awaits relaunches: new browser, new display.
    const relaunched = manager.render('http://y.test/');
    // The old browser's disconnect fires and its close finally completes.
    instances[0].disconnect();
    gate.resolve();
    await firstClose;
    assert.ok(await relaunched);

    assert.equal(displays.length, 2);
    assert.equal(displays[0].wasStopped(), true, 'the old display is stopped');
    assert.equal(displays[1].wasStopped(), false, "the newer display survives the old browser's stale close");

    await manager.close();
    assert.equal(displays[1].wasStopped(), true);
  });
});
