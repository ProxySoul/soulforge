import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";

/**
 * Tests for actual shell execution edge cases.
 * These test the patterns used by shell.ts with real processes.
 * Bugs here = hung processes, lost output, corrupted state.
 */

function runShell(
  command: string,
  opts: { timeout?: number; maxOutput?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  const timeout = opts.timeout ?? 5000;
  const maxOutput = opts.maxOutput ?? 16_384;

  return new Promise((resolve) => {
    const proc = spawn("sh", ["-c", command], { timeout });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let timedOut = false;

    proc.stdout.on("data", (data: Buffer) => {
      if (stdoutLen < maxOutput) {
        stdoutChunks.push(data);
        stdoutLen += data.length;
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      if (stderrLen < maxOutput) {
        stderrChunks.push(data);
        stderrLen += data.length;
      }
    });

    proc.on("error", (err: Error & { code?: string }) => {
      if (err.code === "ERR_CHILD_PROCESS_TIMEOUT" || err.message.includes("timed out")) {
        timedOut = true;
      }
    });

    proc.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8").slice(0, maxOutput),
        stderr: Buffer.concat(stderrChunks).toString("utf-8").slice(0, maxOutput),
        code,
        timedOut,
      });
    });
  });
}

describe("shell execution — basic", () => {
  it("runs simple command", async () => {
    const r = await runShell("echo hello");
    expect(r.stdout.trim()).toBe("hello");
    expect(r.code).toBe(0);
  });

  it("captures exit code", async () => {
    const r = await runShell("exit 42");
    expect(r.code).toBe(42);
  });

  it("captures stderr", async () => {
    const r = await runShell("echo error >&2");
    expect(r.stderr.trim()).toBe("error");
  });

  it("handles empty output", async () => {
    const r = await runShell("true");
    expect(r.stdout).toBe("");
    expect(r.code).toBe(0);
  });
});

describe("shell execution — timeout", () => {
  it("kills process on timeout", async () => {
    const r = await runShell("sleep 10", { timeout: 500 });
    expect(r.code).not.toBe(0);
  }, 3000);

  it("returns non-zero code on timeout", async () => {
    const r = await runShell("sleep 10", { timeout: 500 });
    // Process killed by timeout should not return success
    expect(r.code === null || r.code !== 0).toBe(true);
  }, 3000);
});

describe("shell execution — output limits", () => {
  it("truncates large stdout", async () => {
    const r = await runShell("yes | head -n 100000", { maxOutput: 1024 });
    expect(r.stdout.length).toBeLessThanOrEqual(1024);
  });

  it("handles multiline output", async () => {
    const r = await runShell("for i in $(seq 1 100); do echo line$i; done");
    const lines = r.stdout.trim().split("\n");
    expect(lines.length).toBe(100);
    expect(lines[0]).toBe("line1");
    expect(lines[99]).toBe("line100");
  });
});

describe("shell execution — special characters", () => {
  it("handles single quotes in output", async () => {
    const r = await runShell("echo \"it's working\"");
    expect(r.stdout.trim()).toBe("it's working");
  });

  it("handles unicode output", async () => {
    const r = await runShell("echo '日本語 🎉'");
    expect(r.stdout.trim()).toBe("日本語 🎉");
  });

  it("handles tab characters", async () => {
    const r = await runShell("printf 'a\\tb\\tc'");
    expect(r.stdout).toBe("a\tb\tc");
  });

  it("handles null bytes in output (binary-like)", async () => {
    const r = await runShell("printf 'before\\x00after'");
    // null byte splits the string in most parsers
    expect(r.stdout).toContain("before");
  });
});

describe("shell execution — pipe and redirect", () => {
  it("handles piped commands", async () => {
    const r = await runShell("echo 'hello world' | wc -w");
    expect(r.stdout.trim()).toBe("2");
  });

  it("handles command substitution", async () => {
    const r = await runShell("echo $(echo nested)");
    expect(r.stdout.trim()).toBe("nested");
  });

  it("handles multiple commands with &&", async () => {
    const r = await runShell("echo a && echo b");
    expect(r.stdout.trim()).toBe("a\nb");
  });

  it("handles || fallback", async () => {
    const r = await runShell("false || echo fallback");
    expect(r.stdout.trim()).toBe("fallback");
  });
});

describe("shell execution — error cases", () => {
  it("handles command not found", async () => {
    const r = await runShell("nonexistent_command_xyz 2>&1");
    expect(r.code).not.toBe(0);
  });

  it("handles permission denied", async () => {
    const r = await runShell("cat /etc/shadow 2>&1");
    expect(r.code).not.toBe(0);
  });

  it("handles broken pipe gracefully", async () => {
    const r = await runShell("yes | head -n 1");
    expect(r.stdout.trim()).toBe("y");
    expect(r.code).toBe(0);
  });
});

describe("shell execution — environment", () => {
  it("inherits PATH", async () => {
    const r = await runShell("which sh");
    expect(r.stdout.trim()).toBeTruthy();
    expect(r.code).toBe(0);
  });

  it("handles inline env vars", async () => {
    const r = await runShell("MY_VAR=hello sh -c 'echo $MY_VAR'");
    expect(r.stdout.trim()).toBe("hello");
  });
});
