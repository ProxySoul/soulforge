import { spawn } from "node:child_process";

interface SuspendOpts {
  command: string;
  args?: string[];
  cwd?: string;
  noAltScreen?: boolean;
}

/**
 * Hand terminal control to an interactive process (e.g. lazygit).
 * Disables raw mode, enters alt screen, spawns with inherited stdio,
 * then restores on exit.
 */
export function suspendAndRun(opts: SuspendOpts): Promise<{ exitCode: number | null }> {
  return new Promise((resolve) => {
    // Leave raw mode so the child gets normal terminal input
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }

    // Enter alt screen buffer (unless disabled for non-TUI commands)
    if (!opts.noAltScreen) {
      process.stdout.write("\x1b[?1049h");
    }

    const proc = spawn(opts.command, opts.args ?? [], {
      cwd: opts.cwd ?? process.cwd(),
      stdio: "inherit",
      env: { ...process.env },
    });

    proc.on("close", (code) => {
      if (!opts.noAltScreen) {
        process.stdout.write("\x1b[?1049l");
      }

      // Re-enable raw mode for Ink
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
      }

      resolve({ exitCode: code });
    });

    proc.on("error", () => {
      if (!opts.noAltScreen) {
        process.stdout.write("\x1b[?1049l");
      }
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
      }
      resolve({ exitCode: null });
    });
  });
}
