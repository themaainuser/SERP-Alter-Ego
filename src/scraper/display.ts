import type { ChildProcess } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";

/**
 * A live Xvfb virtual display the headed browser renders into.
 *
 * Why this exists: the SeleniumBase recon found headed Chrome to be the stealth path
 * (headless is the more detectable one), but a Linux server has no screen. Starting
 * Xvfb ourselves lets BROWSER_HEADFUL=true work there out of the box — callers fall
 * back to headless when it cannot start (no binary), so a scrape never dies over it.
 */
export interface DisplaySession {
  display: string;
  env: { DISPLAY: string };
  /** Kill the Xvfb process. Idempotent — close() and the disconnect handler may both call it. */
  stop(): void;
}

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { stdio: ["ignore", "pipe", "pipe"] },
) => ChildProcess;

/**
 * Start Xvfb on a free display (picked by `-displayfd` and read from stdout) and
 * resolve the session for it. Resolves null when the binary is missing, Xvfb dies
 * before reporting, or it never answers within `timeoutMs` — callers then run headless.
 */
export function startXvfb({
  spawn = nodeSpawn as SpawnLike,
  timeoutMs = 5000,
}: { spawn?: SpawnLike; timeoutMs?: number } = {}): Promise<DisplaySession | null> {
  return new Promise((resolve) => {
    const child = spawn("Xvfb", ["-displayfd", "1", "-screen", "0", "1920x1080x24", "-nolisten", "tcp"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const killHook = () => {
      if (!child.killed) child.kill();
    };
    const finish = (session: DisplaySession | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener("exit", killHook);
      resolve(session);
    };
    const stop = () => {
      process.removeListener("exit", killHook);
      if (!child.killed) child.kill();
      finish(null); // no-op once a session has been handed out
    };

    timer = setTimeout(() => {
      // Xvfb accepted the spawn but never reported a display: kill it, don't leak it.
      if (!child.killed) child.kill();
      finish(null);
    }, timeoutMs);
    timer.unref?.(); // a pending display start must never keep the process alive

    let out = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      out += String(chunk);
      const match = /^:(\d+)\s*$/m.exec(out);
      if (match) {
        const display = `:${match[1]}`;
        finish({ display, env: { DISPLAY: display }, stop });
      }
    });
    child.once("error", () => finish(null)); // ENOENT: Xvfb is not installed
    child.once("exit", () => finish(null)); // died before reporting a display
    process.once("exit", killHook); // crash safety: never leave an Xvfb behind
    child.unref(); // Xvfb must not keep the Node process alive on its own
  });
}
