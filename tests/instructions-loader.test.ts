import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInstructionPrompt, loadInstructions } from "../src/core/instructions.js";

describe("instruction loading", () => {
  let rootDir: string;
  let projectDir: string;
  let homeDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "sf-instructions-"));
    projectDir = join(rootDir, "project");
    homeDir = join(rootDir, "home");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("loads project-local instructions when no global file exists", () => {
    writeFileSync(join(projectDir, "AGENTS.md"), "project codex");

    const loaded = loadInstructions(projectDir, ["codex"], { homeDir });

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      source: "codex",
      file: "AGENTS.md",
      scope: "project",
      content: "project codex",
    });
    expect(buildInstructionPrompt(loaded)).toBe("Project instructions:\n[AGENTS.md]\nproject codex");
  });

  it("loads global instructions from the home directory", () => {
    mkdirSync(join(homeDir, ".soulforge"), { recursive: true });
    writeFileSync(join(homeDir, ".soulforge", "instructions.md"), "global soulforge");

    const loaded = loadInstructions(projectDir, ["soulforge"], { homeDir });

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      source: "soulforge",
      file: ".soulforge/instructions.md",
      scope: "global",
      content: "global soulforge",
    });
  });

  it("includes both project-local and global instructions in the prompt", () => {
    writeFileSync(join(projectDir, "AGENTS.md"), "project codex");
    mkdirSync(join(homeDir, ".agents"), { recursive: true });
    writeFileSync(join(homeDir, ".agents", "instructions.md"), "global codex");

    const loaded = loadInstructions(projectDir, ["codex"], { homeDir });
    const prompt = buildInstructionPrompt(loaded);

    expect(loaded.map((inst) => inst.scope)).toEqual(["project", "global"]);
    expect(prompt).toContain("Project-local instruction files:");
    expect(prompt).toContain("[project:AGENTS.md]");
    expect(prompt).toContain("project codex");
    expect(prompt).toContain(
      "Global instruction files apply across all projects and take priority over project-local instruction files when they conflict.",
    );
    expect(prompt).toContain("[global:.agents/instructions.md]");
    expect(prompt).toContain("global codex");
  });
});
