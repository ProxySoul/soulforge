import { describe, expect, test } from "bun:test";

// Test the Soul Map snapshot + diff system for cache safety and correctness.
// These test the ContextManager methods that forge.ts prepareStep calls.

// Since ContextManager has many dependencies (RepoMap, SQLite, etc.),
// we test the logic via a minimal mock that mirrors the real behavior.

interface MockRepoMap {
  ready: boolean;
  files: Map<string, string[]>; // file → dependents
  rendered: string;
}

function createMockContextManager(repoMap: MockRepoMap) {
  const diffChangedFiles = new Set<string>();
  let snapshotClearCount = 0;

  return {
    _diffSet: diffChangedFiles,
    _snapshotClearCount: () => snapshotClearCount,

    onFileChanged(relPath: string) {
      diffChangedFiles.add(relPath);
    },

    buildSoulMapSnapshot(clearDiffTracker = true): string | null {
      if (!repoMap.ready) return null;
      if (!repoMap.rendered) return null;
      if (clearDiffTracker) {
        diffChangedFiles.clear();
        snapshotClearCount++;
      }
      return `<soul_map>${repoMap.rendered}</soul_map>`;
    },

    buildSoulMapDiff(): string | null {
      if (!repoMap.ready) return null;
      if (diffChangedFiles.size === 0) return null;
      const changed = [...diffChangedFiles];
      diffChangedFiles.clear();

      const lines = ["<soul_map_update>"];
      for (const file of changed.slice(0, 15)) {
        const dependents = repoMap.files.get(file) ?? [];
        if (dependents.length > 0) {
          const top = dependents.slice(0, 3);
          lines.push(`  ${file} → affects: ${top.join(", ")}`);
        } else {
          lines.push(`  ${file}`);
        }
      }
      if (changed.length > 15) lines.push(`  (+${String(changed.length - 15)} more)`);
      lines.push("</soul_map_update>");
      return lines.join("\n");
    },

    buildSkillsBlock(): string | null {
      return null;
    },

    buildCrossTabSection(): string | null {
      return null;
    },
  };
}

// Simulates forge prepareStep Soul Map logic
function simulatePrepareStep(
  ctx: ReturnType<typeof createMockContextManager>,
  stepNumber: number,
  snapshotSentRef: { value: boolean },
): string | null {
  if (!snapshotSentRef.value) {
    const snapshot = ctx.buildSoulMapSnapshot();
    if (snapshot) {
      snapshotSentRef.value = true;
      return snapshot;
    }
    return null;
  }
  return ctx.buildSoulMapDiff();
}

describe("Soul Map snapshot + diff", () => {
  test("snapshot at step 0 clears diff tracker", () => {
    const repo: MockRepoMap = { ready: true, files: new Map(), rendered: "file-tree" };
    const ctx = createMockContextManager(repo);

    ctx.onFileChanged("src/a.ts");
    ctx.onFileChanged("src/b.ts");
    expect(ctx._diffSet.size).toBe(2);

    const snapshot = ctx.buildSoulMapSnapshot();
    expect(snapshot).toContain("file-tree");
    expect(ctx._diffSet.size).toBe(0);
  });

  test("snapshot with clearDiffTracker=false preserves diff set", () => {
    const repo: MockRepoMap = { ready: true, files: new Map(), rendered: "file-tree" };
    const ctx = createMockContextManager(repo);

    ctx.onFileChanged("src/a.ts");
    const snapshot = ctx.buildSoulMapSnapshot(false);
    expect(snapshot).toContain("file-tree");
    expect(ctx._diffSet.size).toBe(1);
  });

  test("diff returns null when no changes", () => {
    const repo: MockRepoMap = { ready: true, files: new Map(), rendered: "file-tree" };
    const ctx = createMockContextManager(repo);

    expect(ctx.buildSoulMapDiff()).toBeNull();
  });

  test("diff returns changed files and clears set", () => {
    const repo: MockRepoMap = {
      ready: true,
      files: new Map([["src/a.ts", ["src/b.ts", "src/c.ts"]]]),
      rendered: "file-tree",
    };
    const ctx = createMockContextManager(repo);

    ctx.onFileChanged("src/a.ts");
    ctx.onFileChanged("src/d.ts");

    const diff = ctx.buildSoulMapDiff();
    expect(diff).toContain("src/a.ts → affects: src/b.ts, src/c.ts");
    expect(diff).toContain("src/d.ts");
    expect(ctx._diffSet.size).toBe(0);
  });

  test("diff caps at 15 files", () => {
    const repo: MockRepoMap = { ready: true, files: new Map(), rendered: "file-tree" };
    const ctx = createMockContextManager(repo);

    for (let i = 0; i < 20; i++) {
      ctx.onFileChanged(`src/file-${String(i)}.ts`);
    }

    const diff = ctx.buildSoulMapDiff();
    expect(diff).toContain("(+5 more)");
    expect(ctx._diffSet.size).toBe(0);
  });

  test("repeated edits to same file = one entry", () => {
    const repo: MockRepoMap = { ready: true, files: new Map(), rendered: "file-tree" };
    const ctx = createMockContextManager(repo);

    for (let i = 0; i < 50; i++) {
      ctx.onFileChanged("src/hot-file.ts");
    }

    expect(ctx._diffSet.size).toBe(1);
    const diff = ctx.buildSoulMapDiff();
    expect(diff).toContain("src/hot-file.ts");
    expect(diff).not.toContain("more");
  });

  test("snapshot returns null when repo map not ready", () => {
    const repo: MockRepoMap = { ready: false, files: new Map(), rendered: "" };
    const ctx = createMockContextManager(repo);

    expect(ctx.buildSoulMapSnapshot()).toBeNull();
  });

  test("diff returns null when repo map not ready — preserves changed files", () => {
    const repo: MockRepoMap = { ready: false, files: new Map(), rendered: "" };
    const ctx = createMockContextManager(repo);

    ctx.onFileChanged("src/a.ts");
    expect(ctx.buildSoulMapDiff()).toBeNull();
    expect(ctx._diffSet.size).toBe(1);
  });

  test("no duplicate diffs between steps", () => {
    const repo: MockRepoMap = { ready: true, files: new Map(), rendered: "file-tree" };
    const ctx = createMockContextManager(repo);

    ctx.onFileChanged("src/a.ts");
    const diff1 = ctx.buildSoulMapDiff();
    expect(diff1).toContain("src/a.ts");

    // Second call with no new changes → null (no duplicate)
    const diff2 = ctx.buildSoulMapDiff();
    expect(diff2).toBeNull();

    // New change → only that file
    ctx.onFileChanged("src/b.ts");
    const diff3 = ctx.buildSoulMapDiff();
    expect(diff3).toContain("src/b.ts");
    expect(diff3).not.toContain("src/a.ts");
  });
});

describe("Soul Map mid-turn repo map readiness", () => {
  test("snapshot sent when repo map becomes ready mid-turn", () => {
    const repo: MockRepoMap = { ready: false, files: new Map(), rendered: "file-tree" };
    const ctx = createMockContextManager(repo);
    const snapshotSent = { value: false };

    // Step 0: repo map not ready
    const r0 = simulatePrepareStep(ctx, 0, snapshotSent);
    expect(r0).toBeNull();
    expect(snapshotSent.value).toBe(false);

    // Step 3: repo map becomes ready
    repo.ready = true;
    repo.rendered = "ready-tree";
    const r3 = simulatePrepareStep(ctx, 3, snapshotSent);
    expect(r3).toContain("ready-tree");
    expect(snapshotSent.value).toBe(true);

    // Step 4: now diffs
    ctx.onFileChanged("src/x.ts");
    const r4 = simulatePrepareStep(ctx, 4, snapshotSent);
    expect(r4).toContain("src/x.ts");
    expect(r4).toContain("soul_map_update");
  });

  test("accumulated changes during scan are cleared by snapshot", () => {
    const repo: MockRepoMap = { ready: false, files: new Map(), rendered: "" };
    const ctx = createMockContextManager(repo);
    const snapshotSent = { value: false };

    // Files changed while scanning
    ctx.onFileChanged("src/a.ts");
    ctx.onFileChanged("src/b.ts");
    expect(ctx._diffSet.size).toBe(2);

    // Step 0: not ready
    simulatePrepareStep(ctx, 0, snapshotSent);

    // Scan completes
    repo.ready = true;
    repo.rendered = "full-tree";

    // Step 2: snapshot sent, clears accumulated changes
    simulatePrepareStep(ctx, 2, snapshotSent);
    expect(ctx._diffSet.size).toBe(0);
    expect(snapshotSent.value).toBe(true);
  });
});

describe("Soul Map cross-tab behavior", () => {
  test("edits from other tabs accumulate in diff", () => {
    const repo: MockRepoMap = { ready: true, files: new Map(), rendered: "tree" };
    const ctxA = createMockContextManager(repo);
    const ctxB = createMockContextManager(repo);
    const snapshotA = { value: false };

    // Tab A sends snapshot
    simulatePrepareStep(ctxA, 0, snapshotA);
    expect(snapshotA.value).toBe(true);

    // Tab B edits a file — both CMs get notified in real system
    // In this test, we simulate by calling onFileChanged on both
    ctxA.onFileChanged("src/edited-by-b.ts");
    ctxB.onFileChanged("src/edited-by-b.ts");

    // Tab A's next step sees the edit
    const diff = simulatePrepareStep(ctxA, 1, snapshotA);
    expect(diff).toContain("src/edited-by-b.ts");
  });
});

describe("Soul Map subagent dispatch", () => {
  test("multiple subagent edits appear in one diff", () => {
    const repo: MockRepoMap = { ready: true, files: new Map(), rendered: "tree" };
    const ctx = createMockContextManager(repo);
    const snapshotSent = { value: true }; // Already sent

    // Simulate 5 subagent file edits during one dispatch
    ctx.onFileChanged("src/agent1-edit.ts");
    ctx.onFileChanged("src/agent2-edit.ts");
    ctx.onFileChanged("src/agent3-edit.ts");
    ctx.onFileChanged("src/shared-file.ts");
    ctx.onFileChanged("src/agent1-edit.ts"); // Duplicate — ignored

    expect(ctx._diffSet.size).toBe(4);

    const diff = simulatePrepareStep(ctx, 5, snapshotSent);
    expect(diff).toContain("agent1-edit");
    expect(diff).toContain("agent2-edit");
    expect(diff).toContain("agent3-edit");
    expect(diff).toContain("shared-file");
    expect(ctx._diffSet.size).toBe(0);
  });
});

describe("Soul Map long sessions", () => {
  test("diffs don't accumulate across steps (cleared each time)", () => {
    const repo: MockRepoMap = { ready: true, files: new Map(), rendered: "tree" };
    const ctx = createMockContextManager(repo);
    const snapshotSent = { value: true };

    for (let step = 1; step <= 50; step++) {
      ctx.onFileChanged(`src/step-${String(step)}.ts`);
      const diff = simulatePrepareStep(ctx, step, snapshotSent);
      expect(diff).toContain(`step-${String(step)}`);
      expect(ctx._diffSet.size).toBe(0);
    }
  });

  test("steps with no file changes produce no diff", () => {
    const repo: MockRepoMap = { ready: true, files: new Map(), rendered: "tree" };
    const ctx = createMockContextManager(repo);
    const snapshotSent = { value: true };

    const diff = simulatePrepareStep(ctx, 10, snapshotSent);
    expect(diff).toBeNull();
  });
});
