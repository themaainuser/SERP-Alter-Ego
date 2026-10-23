import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { type SpawnLike, startXvfb } from '../src/scraper/display.js';

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
