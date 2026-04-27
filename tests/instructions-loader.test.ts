import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextManager } from "../src/core/context/manager.js";
import { buildInstructionPrompt, loadInstructions } from "../src/core/instructions.js";

const INSTRUCTIONS_MODULE_URL = new URL("../src/core/instructions.ts", import.meta.url).href;

function loadInstructionsInFreshProcess(
  projectDir: string,
  homeDir: string,
): ReturnType<typeof loadInstructions> {
  const script = `
    import { loadInstructions } from ${JSON.stringify(INSTRUCTIONS_MODULE_URL)};

    const projectDir = process.env.PROJECT_DIR;
    if (!projectDir) throw new Error("PROJECT_DIR missing");

    const loaded = loadInstructions(projectDir, ["soulforge"]);
    process.stdout.write(JSON.stringify(loaded));
  `;

  return JSON.parse(
    execFileSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: homeDir,
        PROJECT_DIR: projectDir,
        USERPROFILE: homeDir,
      },
    }),
  ) as ReturnType<typeof loadInstructions>;
}

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
    writeFileSync(join(homeDir, ".soulforge", "SOULFORGE.md"), "global soulforge");

    const loaded = loadInstructions(projectDir, ["soulforge"], { homeDir });

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      source: "soulforge",
      file: ".soulforge/SOULFORGE.md",
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
    expect(prompt).toContain(
      "Global instruction files apply across all projects, but project-local instruction files take priority when they conflict.",
    );
    expect(prompt).toContain("Project-local instruction files:");
    expect(prompt).toContain("[project:AGENTS.md]");
    expect(prompt).toContain("project codex");
    expect(prompt).toContain("[global:.agents/instructions.md]");
    expect(prompt).toContain("global codex");
    expect(prompt.indexOf("Global instruction files apply across all projects")).toBeLessThan(
      prompt.indexOf("[project:AGENTS.md]"),
    );
    expect(prompt.indexOf("project codex")).toBeGreaterThan(prompt.indexOf("global codex"));
  });

  it("keeps both scopes when project and global instructions share source", () => {
    writeFileSync(join(projectDir, "SOULFORGE.md"), "project soulforge");
    mkdirSync(join(homeDir, ".soulforge"), { recursive: true });
    writeFileSync(join(homeDir, ".soulforge", "SOULFORGE.md"), "global soulforge");

    const loaded = loadInstructions(projectDir, ["soulforge"], { homeDir });
    const prompt = buildInstructionPrompt(loaded);

    expect(loaded.map((inst) => inst.scope)).toEqual(["project", "global"]);
    expect(loaded.map((inst) => inst.content)).toEqual(["project soulforge", "global soulforge"]);
    expect(loaded.map((inst) => inst.file)).toEqual(["SOULFORGE.md", ".soulforge/SOULFORGE.md"]);
    expect(prompt.indexOf("project soulforge")).toBeGreaterThan(prompt.indexOf("global soulforge"));
  });

  it("loads global instructions from homedir() by default in fresh process", () => {
    mkdirSync(join(homeDir, ".soulforge"), { recursive: true });
    writeFileSync(join(homeDir, ".soulforge", "SOULFORGE.md"), "global soulforge");

    const loaded = loadInstructionsInFreshProcess(projectDir, homeDir);

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      source: "soulforge",
      file: ".soulforge/SOULFORGE.md",
      scope: "global",
      content: "global soulforge",
    });
  });

  it("dedupes project and global roots when they resolve to same directory", () => {
    writeFileSync(join(projectDir, "SOULFORGE.md"), "project soulforge");
    const linkedHome = join(rootDir, "linked-home");
    symlinkSync(projectDir, linkedHome, "dir");

    const loaded = loadInstructions(`${projectDir}/`, ["soulforge"], { homeDir: linkedHome });

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      source: "soulforge",
      file: "SOULFORGE.md",
      scope: "project",
      content: "project soulforge",
    });
  });

  it("dedupes symlinked global file targeting project instruction", () => {
    writeFileSync(join(projectDir, "SOULFORGE.md"), "project soulforge");
    mkdirSync(join(homeDir, ".soulforge"), { recursive: true });
    symlinkSync(join(projectDir, "SOULFORGE.md"), join(homeDir, ".soulforge", "SOULFORGE.md"));

    const loaded = loadInstructions(projectDir, ["soulforge"], { homeDir });

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      source: "soulforge",
      file: "SOULFORGE.md",
      scope: "project",
      content: "project soulforge",
    });
  });

  it("invalidates ContextManager instruction cache key when instructions change", () => {
    const ctx = Object.create(ContextManager.prototype) as ContextManager;
    Object.assign(ctx as object, {
      repoMapGeneration: 0,
      skills: new Map(),
      memoryManager: { generation: 0 },
      forgeMode: "default",
      projectInstructions: "",
      projectInstructionsVersion: 0,
      isChild: false,
    });

    const before = ctx.getInstructionsCacheKey("anthropic/claude-sonnet-4-6");
    ctx.setProjectInstructions("global soulforge");
    const after = ctx.getInstructionsCacheKey("anthropic/claude-sonnet-4-6");

    expect(after).not.toBe(before);
    expect(after).toContain("|pi1");
  });
});
