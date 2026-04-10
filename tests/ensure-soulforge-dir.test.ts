import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The module caches which cwds have been patched, so we need a fresh import
// for each test. We work around this by using unique temp dirs per test.
import { ensureSoulforgeDir } from "../src/core/utils/ensure-soulforge-dir.js";

const BASE = join(tmpdir(), `ensure-sf-test-${Date.now()}`);
let testDir: string;
let testIndex = 0;

beforeEach(() => {
  testDir = join(BASE, `t${testIndex++}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true });
});

describe("ensureSoulforgeDir", () => {
  it("creates .soulforge directory", () => {
    ensureSoulforgeDir(testDir);
    expect(existsSync(join(testDir, ".soulforge"))).toBe(true);
  });

  it("returns the .soulforge path", () => {
    const result = ensureSoulforgeDir(testDir);
    expect(result).toBe(join(testDir, ".soulforge"));
  });

  it("appends .soulforge to existing .gitignore", () => {
    // Make it a git repo so gitignore logic triggers
    execSync("git init", { cwd: testDir, stdio: "pipe" });
    writeFileSync(join(testDir, ".gitignore"), "node_modules\ndist\n");

    ensureSoulforgeDir(testDir);

    const content = readFileSync(join(testDir, ".gitignore"), "utf-8");
    expect(content).toContain(".soulforge\n");
    expect(content).toStartWith("node_modules\n");
  });

  it("does not duplicate .soulforge in .gitignore", () => {
    execSync("git init", { cwd: testDir, stdio: "pipe" });
    writeFileSync(join(testDir, ".gitignore"), "node_modules\n.soulforge\n");

    ensureSoulforgeDir(testDir);

    const content = readFileSync(join(testDir, ".gitignore"), "utf-8");
    const count = content.split("\n").filter((l) => l.trim() === ".soulforge").length;
    expect(count).toBe(1);
  });

  it("handles .soulforge/ variant in .gitignore", () => {
    execSync("git init", { cwd: testDir, stdio: "pipe" });
    writeFileSync(join(testDir, ".gitignore"), ".soulforge/\n");

    ensureSoulforgeDir(testDir);

    const content = readFileSync(join(testDir, ".gitignore"), "utf-8");
    // Should not add a duplicate
    expect(content).toBe(".soulforge/\n");
  });

  it("adds newline before .soulforge if .gitignore doesn't end with one", () => {
    execSync("git init", { cwd: testDir, stdio: "pipe" });
    writeFileSync(join(testDir, ".gitignore"), "node_modules");

    ensureSoulforgeDir(testDir);

    const content = readFileSync(join(testDir, ".gitignore"), "utf-8");
    expect(content).toBe("node_modules\n.soulforge\n");
  });

  it("creates .gitignore in a git repo without one", () => {
    execSync("git init", { cwd: testDir, stdio: "pipe" });

    ensureSoulforgeDir(testDir);

    const gitignorePath = join(testDir, ".gitignore");
    expect(existsSync(gitignorePath)).toBe(true);
    expect(readFileSync(gitignorePath, "utf-8")).toBe(".soulforge\n");
  });

  it("does not create .gitignore in a non-git directory", () => {
    ensureSoulforgeDir(testDir);

    expect(existsSync(join(testDir, ".gitignore"))).toBe(false);
  });

  it("respects wildcard patterns like .* that already cover .soulforge", () => {
    execSync("git init", { cwd: testDir, stdio: "pipe" });
    writeFileSync(join(testDir, ".gitignore"), ".*\n");

    ensureSoulforgeDir(testDir);

    const content = readFileSync(join(testDir, ".gitignore"), "utf-8");
    // .* already covers .soulforge — should not append
    expect(content).toBe(".*\n");
  });

  it("never crashes the caller even if git is broken", () => {
    // ensureSoulforgeDir should still return the dir path
    const result = ensureSoulforgeDir(testDir);
    expect(result).toBe(join(testDir, ".soulforge"));
    expect(existsSync(result)).toBe(true);
  });

  it("preserves CRLF line endings when appending", () => {
    execSync("git init", { cwd: testDir, stdio: "pipe" });
    writeFileSync(join(testDir, ".gitignore"), "node_modules\r\ndist\r\n");

    ensureSoulforgeDir(testDir);

    const raw = readFileSync(join(testDir, ".gitignore"), "utf-8");
    // Should use CRLF to match the existing file
    expect(raw).toBe("node_modules\r\ndist\r\n.soulforge\r\n");
  });

  it("preserves CRLF when file doesn't end with newline", () => {
    execSync("git init", { cwd: testDir, stdio: "pipe" });
    writeFileSync(join(testDir, ".gitignore"), "node_modules\r\ndist");

    ensureSoulforgeDir(testDir);

    const raw = readFileSync(join(testDir, ".gitignore"), "utf-8");
    expect(raw).toBe("node_modules\r\ndist\r\n.soulforge\r\n");
  });

  it("respects parent .gitignore in a subdirectory repo", () => {
    // Create a git repo with .gitignore at root
    execSync("git init", { cwd: testDir, stdio: "pipe" });
    writeFileSync(join(testDir, ".gitignore"), ".soulforge\n");

    // Create a subdirectory (simulating a monorepo package)
    const sub = join(testDir, "packages", "app");
    mkdirSync(sub, { recursive: true });

    ensureSoulforgeDir(sub);

    // Should NOT create a .gitignore in the subdirectory — parent already covers it
    expect(existsSync(join(sub, ".gitignore"))).toBe(false);
  });

  it("does not corrupt an empty .gitignore", () => {
    execSync("git init", { cwd: testDir, stdio: "pipe" });
    writeFileSync(join(testDir, ".gitignore"), "");

    ensureSoulforgeDir(testDir);

    const content = readFileSync(join(testDir, ".gitignore"), "utf-8");
    expect(content).toBe(".soulforge\n");
  });

  it("handles read-only .gitignore gracefully", () => {
    execSync("git init", { cwd: testDir, stdio: "pipe" });
    writeFileSync(join(testDir, ".gitignore"), "node_modules\n");
    const { chmodSync } = require("node:fs") as typeof import("node:fs");
    chmodSync(join(testDir, ".gitignore"), 0o444);

    // Should not throw — outer try/catch protects
    const result = ensureSoulforgeDir(testDir);
    expect(existsSync(result)).toBe(true);

    // Restore permissions for cleanup
    chmodSync(join(testDir, ".gitignore"), 0o644);
  });
});
