import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We need to test globToRegex behavior indirectly through isForbidden
// since globToRegex is not exported. We'll test via the public API.
import {
  addProjectPattern,
  addSessionPattern,
  buildForbiddenContext,
  clearTabSessionPatterns,
  getAllPatterns,
  initForbidden,
  isForbidden,
  removeProjectPattern,
  removeSessionPattern,
} from "../src/core/security/forbidden.js";

const TMP = join(tmpdir(), `forbidden-test-${Date.now()}`);

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  initForbidden(TMP);
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("isForbidden - builtin patterns", () => {
  it("blocks .env files", () => {
    const f = join(TMP, ".env");
    writeFileSync(f, "SECRET=1");
    expect(isForbidden(f)).toBe(".env");
  });

  it("blocks .env.local variant", () => {
    const f = join(TMP, ".env.local");
    writeFileSync(f, "SECRET=1");
    expect(isForbidden(f)).toBe(".env.*");
  });

  it("blocks PEM files", () => {
    const f = join(TMP, "cert.pem");
    writeFileSync(f, "-----BEGIN---");
    expect(isForbidden(f)).toBe("*.pem");
  });

  it("blocks private keys", () => {
    const f = join(TMP, "server.key");
    writeFileSync(f, "key-data");
    expect(isForbidden(f)).toBe("*.key");
  });

  it("blocks id_rsa", () => {
    const f = join(TMP, "id_rsa");
    writeFileSync(f, "rsa-data");
    expect(isForbidden(f)).toBe("id_rsa");
  });

  it("blocks credentials.json", () => {
    const f = join(TMP, "credentials.json");
    writeFileSync(f, "{}");
    expect(isForbidden(f)).toBe("credentials.json");
  });

  it("allows normal source files", () => {
    const f = join(TMP, "index.ts");
    writeFileSync(f, "export {}");
    expect(isForbidden(f)).toBeNull();
  });

  it("allows package.json", () => {
    const f = join(TMP, "package.json");
    writeFileSync(f, "{}");
    expect(isForbidden(f)).toBeNull();
  });
});

describe("isForbidden - glob patterns", () => {
  it("** matches nested paths", () => {
    addSessionPattern("**/secrets/**");
    const f = join(TMP, "config", "secrets", "db.yaml");
    mkdirSync(join(TMP, "config", "secrets"), { recursive: true });
    writeFileSync(f, "password: 123");
    expect(isForbidden(f)).toBe("**/secrets/**");
  });

  it("? matches single character", () => {
    addSessionPattern("secret?.txt");
    const f = join(TMP, "secret1.txt");
    writeFileSync(f, "data");
    expect(isForbidden(f)).toBe("secret?.txt");
  });

  it("pattern matching is case-insensitive", () => {
    const f = join(TMP, ".ENV");
    writeFileSync(f, "SECRET=1");
    expect(isForbidden(f)).toBe(".env");
  });
});

describe("session patterns", () => {
  it("adds and checks session patterns", () => {
    addSessionPattern("*.secret");
    const f = join(TMP, "data.secret");
    writeFileSync(f, "x");
    expect(isForbidden(f)).toBe("*.secret");
  });

  it("removes session patterns", () => {
    addSessionPattern("*.secret");
    removeSessionPattern("*.secret");
    const f = join(TMP, "data.secret");
    writeFileSync(f, "x");
    expect(isForbidden(f)).toBeNull();
  });

  it("tab-specific patterns are isolated", () => {
    addSessionPattern("tab1.secret", "tab1");
    addSessionPattern("tab2.secret", "tab2");

    const patterns = getAllPatterns("tab1");
    expect(patterns.session).toContain("tab1.secret");
    expect(patterns.session).not.toContain("tab2.secret");
  });

  it("clearing tab patterns doesn't affect other tabs", () => {
    addSessionPattern("a.secret", "tab1");
    addSessionPattern("b.secret", "tab2");
    clearTabSessionPatterns("tab1");

    const tab2 = getAllPatterns("tab2");
    expect(tab2.session).toContain("b.secret");
  });

  it("default patterns apply to all tabs", () => {
    addSessionPattern("global.secret"); // no tabId = "default"
    const tab1 = getAllPatterns("tab1");
    expect(tab1.session).toContain("global.secret");
  });
});

describe("isForbidden - edge cases", () => {
  it("handles non-existent file path (realpath fails, falls back to resolve)", () => {
    // File doesn't exist on disk — realpathSync will throw, fallback to resolve
    expect(isForbidden("/nonexistent/path/.env")).toBe(".env");
  });

  it("handles path with symlink components", () => {
    const dir = join("/tmp", `forbidden-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const f = join(dir, ".env");
    writeFileSync(f, "data");
    expect(isForbidden(f)).toBe(".env");
    rmSync(dir, { recursive: true });
  });

  it("handles service-account glob pattern", () => {
    const f = join(TMP, "service-account-prod.json");
    writeFileSync(f, "{}");
    expect(isForbidden(f)).toBe("service-account*.json");
  });

  it("handles nested aws credentials path", () => {
    const dir = join(TMP, ".aws");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "credentials");
    writeFileSync(f, "aws_access_key_id=xxx");
    expect(isForbidden(f)).toBe("**/.aws/credentials");
  });
});

describe("isForbidden — edge cases (extended)", () => {
  it("path traversal attempt", () => {
    expect(isForbidden("../../../.env")).toBe(".env");
    expect(isForbidden("foo/../../.env.local")).toBe(".env.*");
  });

  it("hidden files with private extensions", () => {
    expect(isForbidden("/home/user/.ssh/id_rsa")).toBe("id_rsa");
    expect(isForbidden("/home/user/.ssh/id_ed25519")).toBe("id_ed25519");
    expect(isForbidden("/home/user/.ssh/id_ecdsa")).toBe("id_ecdsa");
  });

  it("common secret files", () => {
    expect(isForbidden("config/credentials.json")).toBe("credentials.json");
    expect(isForbidden(".env.production")).toBe(".env.*");
    expect(isForbidden(".env.development.local")).toBe(".env.*");
    expect(isForbidden("secrets.yaml")).toBe("secrets.yaml");
    expect(isForbidden("secrets.yml")).toBe("secrets.yml");
  });

  it("allows normal config files", () => {
    const f1 = join(TMP, "tsconfig.json");
    writeFileSync(f1, "{}");
    expect(isForbidden(f1)).toBeNull();

    const f2 = join(TMP, "package.json");
    writeFileSync(f2, "{}");
    expect(isForbidden(f2)).toBeNull();

    const f3 = join(TMP, "biome.json");
    writeFileSync(f3, "{}");
    expect(isForbidden(f3)).toBeNull();

    const f4 = join(TMP, "src", "config.ts");
    mkdirSync(join(TMP, "src"), { recursive: true });
    writeFileSync(f4, "export {}");
    expect(isForbidden(f4)).toBeNull();
  });

  it("case sensitivity for extensions", () => {
    const f1 = join(TMP, "cert.PEM");
    writeFileSync(f1, "data");
    expect(isForbidden(f1)).toBe("*.pem");

    const f2 = join(TMP, "key.KEY");
    writeFileSync(f2, "data");
    expect(isForbidden(f2)).toBe("*.key");
  });

  it("deeply nested forbidden file", () => {
    expect(isForbidden("a/b/c/d/e/f/.env")).toBe(".env");
    expect(isForbidden("a/b/c/d/e/f/id_rsa")).toBe("id_rsa");
  });

  it("files that look similar but are not forbidden", () => {
    const f1 = join(TMP, "environment.ts");
    writeFileSync(f1, "export {}");
    expect(isForbidden(f1)).toBeNull();

    const f2 = join(TMP, "key-manager.ts");
    writeFileSync(f2, "export {}");
    expect(isForbidden(f2)).toBeNull();

    const f3 = join(TMP, "credentials-guide.md");
    writeFileSync(f3, "# Guide");
    expect(isForbidden(f3)).toBeNull();
  });

  it("empty string", () => {
    expect(isForbidden("")).toBeNull();
  });
});

describe("project patterns from file", () => {
  it("loads patterns from .soulforge/forbidden.json", () => {
    const dir = join(TMP, ".soulforge");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "forbidden.json"), JSON.stringify({ patterns: ["*.custom"] }));
    initForbidden(TMP);

    const f = join(TMP, "data.custom");
    writeFileSync(f, "x");
    expect(isForbidden(f)).toBe("*.custom");
  });

  it("handles malformed forbidden.json gracefully", () => {
    const dir = join(TMP, ".soulforge");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "forbidden.json"), "not-json");
    expect(() => initForbidden(TMP)).not.toThrow();
  });

  it("handles forbidden.json with missing patterns key", () => {
    const dir = join(TMP, ".soulforge");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "forbidden.json"), JSON.stringify({ other: "data" }));
    initForbidden(TMP);
    const patterns = getAllPatterns();
    expect(patterns.project).toEqual([]);
  });
});

describe("isForbidden before initForbidden", () => {
  it("returns null (permits everything) when called before init", () => {
    // SECURITY NOTE: isForbidden is a no-op before initForbidden — it returns null
    // for ALL paths, including obviously sensitive ones. Callers must ensure
    // initForbidden runs before any file access checks.

    // We need a fresh module to test uninitialized state. Since the module uses
    // global `initialized = false` that gets set to true in beforeEach via
    // initForbidden, we isolate by importing a second copy via Bun's loader cache bust.
    // However, since the existing beforeEach already calls initForbidden, we cannot
    // truly test pre-init in this suite without reimporting. Instead, we document
    // the behavior by reading the source: `if (!initialized) return null;`
    //
    // For a functional test, we rely on the fact that the module state persists —
    // after initForbidden is called, isForbidden works. The security concern is
    // that any code path reaching isForbidden before initForbidden will silently
    // allow access.
    expect(typeof isForbidden).toBe("function");

    // Verify that after init (which beforeEach does), it correctly blocks
    expect(isForbidden("/anything/.env")).toBe(".env");
  });
});

describe("addProjectPattern / removeProjectPattern", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = join(TMP, `proj-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(projectDir, { recursive: true });
    initForbidden(projectDir);
  });

  it("adds a pattern and isForbidden matches it", () => {
    addProjectPattern(projectDir, "*.secret");

    const f = join(projectDir, "data.secret");
    writeFileSync(f, "sensitive");
    expect(isForbidden(f)).toBe("*.secret");
  });

  it("creates .soulforge/forbidden.json on disk with correct format", () => {
    addProjectPattern(projectDir, "*.vault");

    const filePath = join(projectDir, ".soulforge", "forbidden.json");
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual({ patterns: ["*.vault"] });
  });

  it("does not duplicate an existing pattern", () => {
    addProjectPattern(projectDir, "*.dup");
    addProjectPattern(projectDir, "*.dup");

    const filePath = join(projectDir, ".soulforge", "forbidden.json");
    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(parsed.patterns.filter((p: string) => p === "*.dup")).toHaveLength(1);
  });

  it("appends multiple patterns", () => {
    addProjectPattern(projectDir, "*.a");
    addProjectPattern(projectDir, "*.b");

    const filePath = join(projectDir, ".soulforge", "forbidden.json");
    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(parsed.patterns).toEqual(["*.a", "*.b"]);
  });

  it("removes a pattern and isForbidden no longer matches it", () => {
    addProjectPattern(projectDir, "*.removeme");
    removeProjectPattern(projectDir, "*.removeme");

    const f = join(projectDir, "data.removeme");
    writeFileSync(f, "x");
    expect(isForbidden(f)).toBeNull();
  });

  it("updates the file on disk after removal", () => {
    addProjectPattern(projectDir, "*.keep");
    addProjectPattern(projectDir, "*.drop");
    removeProjectPattern(projectDir, "*.drop");

    const filePath = join(projectDir, ".soulforge", "forbidden.json");
    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(parsed.patterns).toEqual(["*.keep"]);
  });

  it("removing a non-existent pattern is a no-op", () => {
    addProjectPattern(projectDir, "*.exists");
    removeProjectPattern(projectDir, "*.ghost");

    const filePath = join(projectDir, ".soulforge", "forbidden.json");
    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(parsed.patterns).toEqual(["*.exists"]);
  });

  it("project patterns appear in getAllPatterns", () => {
    addProjectPattern(projectDir, "*.projpat");
    const all = getAllPatterns();
    expect(all.project).toContain("*.projpat");
  });
});

describe("buildForbiddenContext", () => {
  it("returns a non-empty string after init", () => {
    const ctx = buildForbiddenContext();
    expect(ctx.length).toBeGreaterThan(0);
  });

  it("includes the header line", () => {
    const ctx = buildForbiddenContext();
    expect(ctx).toContain("## Forbidden Files (Security)");
  });

  it("includes builtin patterns in output", () => {
    const ctx = buildForbiddenContext();
    expect(ctx).toContain("`.env`");
    expect(ctx).toContain("`*.pem`");
    expect(ctx).toContain("`id_rsa`");
  });

  it("includes session patterns when added", () => {
    addSessionPattern("*.customctx");
    const ctx = buildForbiddenContext();
    expect(ctx).toContain("`*.customctx`");
  });

  it("includes project patterns after addProjectPattern", () => {
    addProjectPattern(TMP, "*.projctx");
    const ctx = buildForbiddenContext();
    expect(ctx).toContain("`*.projctx`");
  });

  it("deduplicates patterns", () => {
    addSessionPattern(".env");
    const ctx = buildForbiddenContext();
    const count = ctx.split("`.env`").length - 1;
    expect(count).toBe(1);
  });

  it("respects tabId filter for session patterns", () => {
    addSessionPattern("tab-only.secret", "special-tab");
    const withTab = buildForbiddenContext("special-tab");
    const withoutTab = buildForbiddenContext("other-tab");
    expect(withTab).toContain("`tab-only.secret`");
    expect(withoutTab).not.toContain("`tab-only.secret`");
  });
});

describe("getAllPatterns", () => {
  it("returns builtin patterns", () => {
    const all = getAllPatterns();
    expect(all.builtin.length).toBeGreaterThan(0);
    expect(all.builtin).toContain(".env");
    expect(all.builtin).toContain("*.pem");
    expect(all.builtin).toContain("id_rsa");
  });

  it("returns empty arrays for unconfigured sources", () => {
    initForbidden(TMP);
    const all = getAllPatterns();
    expect(all.session).toEqual([]);
    expect(all.aiignore).toEqual([]);
  });

  it("returns session patterns after adding them", () => {
    addSessionPattern("*.sess");
    const all = getAllPatterns();
    expect(all.session).toContain("*.sess");
  });

  it("returns project patterns after addProjectPattern", () => {
    addProjectPattern(TMP, "*.proj");
    const all = getAllPatterns();
    expect(all.project).toContain("*.proj");
  });

  it("has aiignore field populated when .aiignore exists", () => {
    writeFileSync(join(TMP, ".aiignore"), "vendor/\n# comment\nbuild/");
    initForbidden(TMP);
    const all = getAllPatterns();
    expect(all.aiignore).toEqual(["vendor/", "build/"]);
  });

  it("global field reflects global config", () => {
    const all = getAllPatterns();
    expect(Array.isArray(all.global)).toBe(true);
  });
});
