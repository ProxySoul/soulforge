import type { ChildProcess } from "node:child_process";

const tracked = new Set<ChildProcess>();

/** Track a node child_process — auto-removed on exit. */
export function trackProcess(proc: ChildProcess): void {
  tracked.add(proc);
  proc.on("exit", () => tracked.delete(proc));
}

/**
 * Bun.spawn returns a Subprocess, not a ChildProcess.
 * We track its PID so we can kill it during cleanup.
 */
interface BunSubprocess {
  readonly pid: number;
  readonly exited: Promise<unknown>;
  kill(signal?: number): void;
}

const trackedBun = new Set<BunSubprocess>();

/** Track a Bun.spawn subprocess — auto-removed on exit. */
export function trackBunProcess(proc: BunSubprocess): void {
  trackedBun.add(proc);
  proc.exited.then(() => trackedBun.delete(proc)).catch(() => trackedBun.delete(proc));
}

/** Kill all tracked processes (node + Bun). SIGTERM first, then synchronous SIGKILL. */
export function killAllTracked(): void {
  // SIGTERM all node child processes
  for (const proc of tracked) {
    try {
      proc.kill("SIGTERM");
    } catch {}
  }
  // SIGTERM all Bun subprocesses
  for (const proc of trackedBun) {
    try {
      proc.kill(2); // SIGINT — Bun.kill uses signal numbers
    } catch {}
  }

  // Synchronous SIGKILL fallback — setTimeout won't fire during process.exit()
  // so we do it immediately after a brief spin-wait.
  for (const proc of tracked) {
    try {
      proc.kill("SIGKILL");
    } catch {}
  }
  tracked.clear();

  for (const proc of trackedBun) {
    try {
      proc.kill(9); // SIGKILL
    } catch {}
  }
  trackedBun.clear();
}

/**
 * Nuclear fallback: kill our entire process group.
 * This catches any child that escaped individual tracking (e.g. grandchildren).
 * Called as the very last cleanup step.
 */
export function killProcessGroup(): void {
  try {
    // process.pid's group — negative PID targets the group
    process.kill(-process.pid, "SIGTERM");
  } catch {
    // ESRCH = no such process group (already dead), EPERM = not allowed — both fine
  }
}
