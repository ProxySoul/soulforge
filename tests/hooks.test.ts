import { describe, test, expect } from "vitest";
import { matchesToolName, toClaudeToolName } from "../src/core/hooks/tool-names.js";
import { invalidateHooksCache, loadHooks } from "../src/core/hooks/loader.js";
import { resetOnceTracking, runHooks } from "../src/core/hooks/runner.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Tool name mapping ────────────────────────────────────────────────

describe("toClaudeToolName", () => {
  test("maps SoulForge tool names to Claude Code names", () => {
    expect(toClaudeToolName("shell")).toBe("Bash");
    expect(toClaudeToolName("edit_file")).toBe("Edit");
    expect(toClaudeToolName("multi_edit")).toBe("MultiEdit");
    expect(toClaudeToolName("read")).toBe("Read");
    expect(toClaudeToolName("grep")).toBe("Grep");
    expect(toClaudeToolName("glob")).toBe("Glob");
    expect(toClaudeToolName("git")).toBe("Git");
    expect(toClaudeToolName("web_search")).toBe("WebSearch");
    expect(toClaudeToolName("fetch_page")).toBe("WebFetch");
    expect(toClaudeToolName("dispatch")).toBe("Agent");
    expect(toClaudeToolName("ask_user")).toBe("AskFollowupQuestion");
    expect(toClaudeToolName("navigate")).toBe("Navigate");
    expect(toClaudeToolName("list_dir")).toBe("ListDirectory");
    expect(toClaudeToolName("task_list")).toBe("TaskList");
  });

  test("returns original name for unmapped tools", () => {
    expect(toClaudeToolName("custom_tool")).toBe("custom_tool");
    expect(toClaudeToolName("mcp__server__tool")).toBe("mcp__server__tool");
  });
});

// ── Matcher ──────────────────────────────────────────────────────────

describe("matchesToolName", () => {
  test("undefined/empty/star matches everything", () => {
    expect(matchesToolName(undefined, "shell")).toBe(true);
    expect(matchesToolName("", "edit_file")).toBe(true);
    expect(matchesToolName("*", "read")).toBe(true);
  });

  test("exact Claude Code name match", () => {
    expect(matchesToolName("Bash", "shell")).toBe(true);
    expect(matchesToolName("Edit", "edit_file")).toBe(true);
    expect(matchesToolName("Edit", "multi_edit")).toBe(true);
    expect(matchesToolName("MultiEdit", "multi_edit")).toBe(true);
    expect(matchesToolName("Read", "read")).toBe(true);
    expect(matchesToolName("ListDirectory", "list_dir")).toBe(true);
    expect(matchesToolName("AskFollowupQuestion", "ask_user")).toBe(true);
    expect(matchesToolName("Bash", "edit_file")).toBe(false);
  });

  test("Claude Code aliases (Write, ListDir, TodoRead/TodoWrite)", () => {
    // Write is a Claude Code alias for file creation — maps to edit_file
    expect(matchesToolName("Write", "edit_file")).toBe(true);
    expect(matchesToolName("Write", "multi_edit")).toBe(false);
    // Edit|Write is the common Claude Code pattern for file mutation hooks
    expect(matchesToolName("Edit|Write", "edit_file")).toBe(true);
    expect(matchesToolName("Edit|Write", "multi_edit")).toBe(true);
    // ListDir shorthand
    expect(matchesToolName("ListDir", "list_dir")).toBe(true);
    // Old Claude Code name
    expect(matchesToolName("AskUserQuestion", "ask_user")).toBe(true);
    // TodoRead/TodoWrite → task_list
    expect(matchesToolName("TodoRead", "task_list")).toBe(true);
    expect(matchesToolName("TodoWrite", "task_list")).toBe(true);
    expect(matchesToolName("TodoRead|TodoWrite", "task_list")).toBe(true);
  });

  test("exact SoulForge name match", () => {
    expect(matchesToolName("shell", "shell")).toBe(true);
    expect(matchesToolName("edit_file", "edit_file")).toBe(true);
    expect(matchesToolName("shell", "edit_file")).toBe(false);
  });

  test("pipe-separated list", () => {
    expect(matchesToolName("Bash|Edit", "shell")).toBe(true);
    expect(matchesToolName("Bash|Edit", "edit_file")).toBe(true);
    expect(matchesToolName("Bash|Edit", "multi_edit")).toBe(true);
    expect(matchesToolName("Bash|Edit", "read")).toBe(false);
    // SoulForge names in pipe list
    expect(matchesToolName("shell|edit_file", "shell")).toBe(true);
    expect(matchesToolName("shell|edit_file", "edit_file")).toBe(true);
  });

  test("regex matcher", () => {
    expect(matchesToolName("^mcp__.*", "mcp__server__tool")).toBe(true);
    expect(matchesToolName("^mcp__.*", "shell")).toBe(false);
    expect(matchesToolName("^(Bash|Edit)$", "shell")).toBe(true);
    expect(matchesToolName("^(Bash|Edit)$", "read")).toBe(false);
    // Regex with special chars triggers regex mode
    expect(matchesToolName("Web.*", "web_search")).toBe(true);
    expect(matchesToolName("Web.*", "fetch_page")).toBe(true); // WebFetch matches Web.*
  });

  test("invalid regex falls back to literal", () => {
    // When regex is invalid, falls back to literal string comparison
    // against both Claude and SoulForge names — won't match real tools
    expect(matchesToolName("(?P<broken", "shell")).toBe(false);
    expect(matchesToolName("(?P<broken", "edit_file")).toBe(false);
    expect(matchesToolName("***", "read")).toBe(false);
  });
});

// ── Loader ───────────────────────────────────────────────────────────

describe("loadHooks", () => {
  const testDir = join(tmpdir(), `soulforge-hooks-test-${Date.now()}`);

  function setup(files: Record<string, unknown>) {
    for (const [relPath, content] of Object.entries(files)) {
      const fullPath = join(testDir, relPath);
      const dir = fullPath.replace(/\/[^/]+$/, "");
      mkdirSync(dir, { recursive: true });
      writeFileSync(fullPath, JSON.stringify(content, null, 2));
    }
  }

  function cleanup() {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }

  test("loads hooks from .claude/settings.json", () => {
    cleanup();
    setup({
      ".claude/settings.json": {
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "echo test" }],
            },
          ],
        },
      },
    });

    const hooks = loadHooks(testDir);
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PreToolUse![0].matcher).toBe("Bash");
    expect(hooks.PreToolUse![0].hooks).toHaveLength(1);
    expect(hooks.PreToolUse![0].hooks[0].type).toBe("command");
    cleanup();
  });

  test("merges hooks from multiple sources", () => {
    cleanup();
    setup({
      ".claude/settings.json": {
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "echo claude" }] },
          ],
        },
      },
      ".soulforge/config.json": {
        hooks: {
          PreToolUse: [
            { matcher: "Edit", hooks: [{ type: "command", command: "echo soulforge" }] },
          ],
        },
      },
    });

    const hooks = loadHooks(testDir);
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(hooks.PreToolUse![0].matcher).toBe("Bash");
    expect(hooks.PreToolUse![1].matcher).toBe("Edit");
    cleanup();
  });

  test("returns empty config when no hooks files exist", () => {
    cleanup();
    mkdirSync(testDir, { recursive: true });
    const hooks = loadHooks(testDir);
    expect(hooks.PreToolUse).toBeUndefined();
    expect(hooks.PostToolUse).toBeUndefined();
    cleanup();
  });

  test("ignores malformed JSON", () => {
    cleanup();
    const dir = join(testDir, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), "not json{{{");
    const hooks = loadHooks(testDir);
    expect(hooks.PreToolUse).toBeUndefined();
    cleanup();
  });

  test("ignores files without hooks key", () => {
    cleanup();
    setup({
      ".claude/settings.json": { someOtherConfig: true },
    });
    const hooks = loadHooks(testDir);
    expect(hooks.PreToolUse).toBeUndefined();
    cleanup();
  });

  test("handles PostToolUse hooks", () => {
    cleanup();
    setup({
      ".claude/settings.json": {
        hooks: {
          PostToolUse: [
            {
              matcher: "Edit|Write",
              hooks: [{ type: "command", command: "npx prettier --write", async: true }],
            },
          ],
        },
      },
    });

    const hooks = loadHooks(testDir);
    expect(hooks.PostToolUse).toHaveLength(1);
    expect(hooks.PostToolUse![0].hooks[0]).toEqual({
      type: "command",
      command: "npx prettier --write",
      async: true,
    });
    cleanup();
  });

  test("handles multiple events", () => {
    cleanup();
    setup({
      ".claude/settings.json": {
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] },
          ],
          PostToolUse: [
            { matcher: "Edit", hooks: [{ type: "command", command: "echo post" }] },
          ],
          SessionStart: [
            { hooks: [{ type: "command", command: "echo start" }] },
          ],
        },
      },
    });

    const hooks = loadHooks(testDir);
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PostToolUse).toHaveLength(1);
    expect(hooks.SessionStart).toHaveLength(1);
    cleanup();
  });
});

// ── Runner ───────────────────────────────────────────────────────────

describe("runHooks", () => {
  const testDir = join(tmpdir(), `soulforge-hooks-runner-${Date.now()}`);

  function setup(config: unknown) {
    const dir = join(testDir, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify(config, null, 2));
    invalidateHooksCache();
  }

  function cleanup() {
    invalidateHooksCache();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }

  test("returns ok when no hooks configured", async () => {
    cleanup();
    mkdirSync(testDir, { recursive: true });
    const result = await runHooks({
      event: "PreToolUse",
      toolName: "shell",
      cwd: testDir,
    });
    expect(result.ok).toBe(true);
    expect(result.blocked).toBe(false);
    cleanup();
  });

  test("runs a passing hook (exit 0)", async () => {
    cleanup();
    setup({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "exit 0" }] },
        ],
      },
    });
    const result = await runHooks({
      event: "PreToolUse",
      toolName: "shell",
      cwd: testDir,
    });
    expect(result.ok).toBe(true);
    expect(result.blocked).toBe(false);
    cleanup();
  });

  test("blocks on exit 2", async () => {
    cleanup();
    setup({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "exit 2" }] },
        ],
      },
    });
    const result = await runHooks({
      event: "PreToolUse",
      toolName: "shell",
      cwd: testDir,
    });
    expect(result.blocked).toBe(true);
    cleanup();
  });

  test("non-blocking on exit 1 — pipeline continues", async () => {
    cleanup();
    setup({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "exit 1" }] },
        ],
      },
    });
    const result = await runHooks({
      event: "PreToolUse",
      toolName: "shell",
      cwd: testDir,
    });
    // Non-blocking errors are logged but don't fail the pipeline
    expect(result.ok).toBe(true);
    expect(result.blocked).toBe(false);
    cleanup();
  });

  test("parses JSON deny decision from stdout", async () => {
    cleanup();
    const script = `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Blocked by policy"}}'`;
    setup({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: script }] },
        ],
      },
    });
    const result = await runHooks({
      event: "PreToolUse",
      toolName: "shell",
      cwd: testDir,
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("Blocked by policy");
    cleanup();
  });

  test("skips hooks that don't match the tool", async () => {
    cleanup();
    setup({
      hooks: {
        PreToolUse: [
          { matcher: "Edit", hooks: [{ type: "command", command: "exit 2" }] },
        ],
      },
    });
    const result = await runHooks({
      event: "PreToolUse",
      toolName: "shell",
      cwd: testDir,
    });
    expect(result.ok).toBe(true);
    expect(result.blocked).toBe(false);
    cleanup();
  });

  test("times out and resolves as non-blocking", async () => {
    cleanup();
    setup({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "sleep 30", timeout: 1 }] },
        ],
      },
    });
    const result = await runHooks({
      event: "PreToolUse",
      toolName: "shell",
      cwd: testDir,
    });
    // Timeout is non-blocking — pipeline continues
    expect(result.blocked).toBe(false);
    cleanup();
  }, 5000);

  test("receives tool input via stdin", async () => {
    cleanup();
    const stdinFile = join(testDir, "stdin_capture.json");
    // Hook captures stdin to a file so we can verify it
    const script = `cat > "${stdinFile}"`;
    setup({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: script }] },
        ],
      },
    });
    await runHooks({
      event: "PreToolUse",
      toolName: "shell",
      toolInput: { command: "ls" },
      cwd: testDir,
    });
    const { readFileSync } = await import("node:fs");
    const captured = JSON.parse(readFileSync(stdinFile, "utf-8"));
    expect(captured.tool_name).toBe("Bash");
    expect(captured.tool_input).toEqual({ command: "ls" });
    expect(captured.hook_event_name).toBe("PreToolUse");
    cleanup();
  });

  test("respects abort signal", async () => {
    cleanup();
    setup({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "sleep 30" }] },
        ],
      },
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const result = await runHooks({
      event: "PreToolUse",
      toolName: "shell",
      cwd: testDir,
      abortSignal: ac.signal,
    });
    // Aborted hooks are non-blocking — pipeline continues
    expect(result.blocked).toBe(false);
    cleanup();
  }, 5000);
});

// ── disableAllHooks ──────────────────────────────────────────────────

describe("disableAllHooks", () => {
  const testDir = join(tmpdir(), `soulforge-hooks-disable-${Date.now()}`);

  function setup(files: Record<string, unknown>) {
    for (const [relPath, content] of Object.entries(files)) {
      const fullPath = join(testDir, relPath);
      const dir = fullPath.replace(/\/[^/]+$/, "");
      mkdirSync(dir, { recursive: true });
      writeFileSync(fullPath, JSON.stringify(content, null, 2));
    }
  }

  function cleanup() {
    invalidateHooksCache();
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  }

  test("disableAllHooks in settings.local.json kills all hooks", () => {
    cleanup();
    setup({
      ".claude/settings.json": {
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "exit 2" }] }],
        },
      },
      ".claude/settings.local.json": { disableAllHooks: true },
    });
    const hooks = loadHooks(testDir);
    expect(hooks.PreToolUse).toBeUndefined();
    cleanup();
  });

  test("disableAllHooks in soulforge config kills all hooks", () => {
    cleanup();
    setup({
      ".claude/settings.json": {
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "exit 2" }] }],
        },
      },
      ".soulforge/config.json": { disableAllHooks: true },
    });
    const hooks = loadHooks(testDir);
    expect(hooks.PreToolUse).toBeUndefined();
    cleanup();
  });

  test("hooks load normally when disableAllHooks is false", () => {
    cleanup();
    setup({
      ".claude/settings.json": {
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo ok" }] }],
        },
      },
      ".claude/settings.local.json": { disableAllHooks: false },
    });
    const hooks = loadHooks(testDir);
    expect(hooks.PreToolUse).toHaveLength(1);
    cleanup();
  });
});

// ── once: true ───────────────────────────────────────────────────────

describe("once: true", () => {
  const testDir = join(tmpdir(), `soulforge-hooks-once-${Date.now()}`);

  function setup(config: unknown) {
    const dir = join(testDir, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify(config, null, 2));
    invalidateHooksCache();
  }

  function cleanup() {
    invalidateHooksCache();
    resetOnceTracking();
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  }

  test("once:true hook fires first time, skips second", async () => {
    cleanup();
    const outFile = join(testDir, "once_count");
    // Append a line each time — count lines to verify invocations
    setup({
      hooks: {
        PreToolUse: [{
          matcher: "Bash",
          hooks: [{ type: "command", command: `echo x >> "${outFile}"`, once: true }],
        }],
      },
    });

    await runHooks({ event: "PreToolUse", toolName: "shell", cwd: testDir });
    await runHooks({ event: "PreToolUse", toolName: "shell", cwd: testDir });
    await runHooks({ event: "PreToolUse", toolName: "shell", cwd: testDir });

    const { readFileSync } = await import("node:fs");
    const lines = readFileSync(outFile, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    cleanup();
  });

  test("hook without once:true fires every time", async () => {
    cleanup();
    const outFile = join(testDir, "no_once_count");
    setup({
      hooks: {
        PreToolUse: [{
          matcher: "Bash",
          hooks: [{ type: "command", command: `echo x >> "${outFile}"` }],
        }],
      },
    });

    await runHooks({ event: "PreToolUse", toolName: "shell", cwd: testDir });
    await runHooks({ event: "PreToolUse", toolName: "shell", cwd: testDir });
    await runHooks({ event: "PreToolUse", toolName: "shell", cwd: testDir });

    const { readFileSync } = await import("node:fs");
    const lines = readFileSync(outFile, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);
    cleanup();
  });
});

// ── if: conditional execution ────────────────────────────────────────

describe("if: conditional", () => {
  const testDir = join(tmpdir(), `soulforge-hooks-if-${Date.now()}`);

  function setup(config: unknown) {
    const dir = join(testDir, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify(config, null, 2));
    invalidateHooksCache();
  }

  function cleanup() {
    invalidateHooksCache();
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  }

  test("if condition matches — hook fires", async () => {
    cleanup();
    setup({
      hooks: {
        PreToolUse: [{
          matcher: "Bash",
          hooks: [{ type: "command", command: "exit 2", if: "Bash(git *)" }],
        }],
      },
    });
    const result = await runHooks({
      event: "PreToolUse",
      toolName: "shell",
      toolInput: { command: "git status" },
      cwd: testDir,
    });
    expect(result.blocked).toBe(true);
    cleanup();
  });

  test("if condition doesn't match — hook skipped", async () => {
    cleanup();
    setup({
      hooks: {
        PreToolUse: [{
          matcher: "Bash",
          hooks: [{ type: "command", command: "exit 2", if: "Bash(git *)" }],
        }],
      },
    });
    const result = await runHooks({
      event: "PreToolUse",
      toolName: "shell",
      toolInput: { command: "ls -la" },
      cwd: testDir,
    });
    expect(result.blocked).toBe(false);
    cleanup();
  });

  test("if with wrong tool name — hook skipped", async () => {
    cleanup();
    setup({
      hooks: {
        PreToolUse: [{
          matcher: "Bash",
          hooks: [{ type: "command", command: "exit 2", if: "Edit(*.ts)" }],
        }],
      },
    });
    const result = await runHooks({
      event: "PreToolUse",
      toolName: "shell",
      toolInput: { command: "echo hello" },
      cwd: testDir,
    });
    expect(result.blocked).toBe(false);
    cleanup();
  });

  test("if with file glob pattern", async () => {
    cleanup();
    setup({
      hooks: {
        PreToolUse: [{
          matcher: "Edit",
          hooks: [{ type: "command", command: "exit 2", if: "Edit(*.ts)" }],
        }],
      },
    });
    // Matches .ts file
    const r1 = await runHooks({
      event: "PreToolUse",
      toolName: "edit_file",
      toolInput: { path: "src/index.ts", oldString: "", newString: "" },
      cwd: testDir,
    });
    expect(r1.blocked).toBe(true);

    // Doesn't match .js file
    const r2 = await runHooks({
      event: "PreToolUse",
      toolName: "edit_file",
      toolInput: { path: "src/index.js", oldString: "", newString: "" },
      cwd: testDir,
    });
    expect(r2.blocked).toBe(false);
    cleanup();
  });

  test("no if field — hook always fires", async () => {
    cleanup();
    setup({
      hooks: {
        PreToolUse: [{
          matcher: "Bash",
          hooks: [{ type: "command", command: "exit 2" }],
        }],
      },
    });
    const result = await runHooks({
      event: "PreToolUse",
      toolName: "shell",
      toolInput: { command: "anything" },
      cwd: testDir,
    });
    expect(result.blocked).toBe(true);
    cleanup();
  });
});
