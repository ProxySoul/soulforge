import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseGitLogLine,
  parseStatusLine,
  unquoteGitPath,
  isGitRepo,
  getGitBranch,
  getGitStatus,
  getGitLog,
  getGitDiff,
  gitInit,
  gitCommit,
  gitAdd,
  gitStash,
  gitStashPop,
  gitStashList,
  gitStashShow,
  gitStashDrop,
  gitCreateBranch,
  gitSwitchBranch,
  buildGitContext,
  setCoAuthorEnabled,
  run,
} from "../src/core/git/status.js";

// ─── Helpers ───

const TMP = join(tmpdir(), `git-test-${Date.now()}`);

beforeAll(() => mkdirSync(TMP, { recursive: true }));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function makeTempDir(name: string): string {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function initRepo(name: string): Promise<string> {
  const dir = makeTempDir(name);
  await gitInit(dir);
  await run(["config", "user.email", "test@test.com"], dir);
  await run(["config", "user.name", "Test"], dir);
  return dir;
}

async function initRepoWithCommit(name: string, files: Record<string, string> = { "init.txt": "init" }): Promise<string> {
  const dir = await initRepo(name);
  for (const [file, content] of Object.entries(files)) {
    const filePath = join(dir, file);
    const fileDir = filePath.substring(0, filePath.lastIndexOf("/"));
    if (fileDir !== dir) mkdirSync(fileDir, { recursive: true });
    writeFileSync(filePath, content);
  }
  await gitAdd(dir, Object.keys(files));
  setCoAuthorEnabled(false);
  await gitCommit(dir, "initial");
  setCoAuthorEnabled(true);
  return dir;
}

// ─── parseGitLogLine ───

describe("parseGitLogLine", () => {
  it("parses normal log line", () => {
    const result = parseGitLogLine("abc1234 feat: add feature (2 hours ago)");
    expect(result.hash).toBe("abc1234");
    expect(result.subject).toBe("feat: add feature");
    expect(result.date).toBe("2 hours ago");
  });

  it("handles subject containing parentheses", () => {
    const result = parseGitLogLine("abc1234 fix(core): bug fix (3 days ago)");
    expect(result.subject).toBe("fix(core): bug fix");
    expect(result.date).toBe("3 days ago");
  });

  it("handles line with no date parentheses", () => {
    const result = parseGitLogLine("abc1234 initial commit");
    expect(result.subject).toBe("initial commit");
    expect(result.date).toBe("");
  });

  it("handles empty subject with only date parens", () => {
    const result = parseGitLogLine("abc1234 (just now)");
    expect(result.subject).toBe("");
    expect(result.date).toBe("just now");
  });

  it("handles line with no spaces", () => {
    const result = parseGitLogLine("nospace");
    expect(result.hash).toBe("nospace");
    expect(result.subject).toBe("");
    expect(result.date).toBe("");
  });

  it("handles empty string", () => {
    const result = parseGitLogLine("");
    expect(result.hash).toBe("");
    expect(result.subject).toBe("");
    expect(result.date).toBe("");
  });

  it("handles multiple parenthesized groups — lastIndexOf grabs date paren", () => {
    const result = parseGitLogLine("abc1234 feat(core): fix (issue #123) (5 min ago)");
    expect(result.subject).toBe("feat(core): fix (issue #123)");
    expect(result.date).toBe("5 min ago");
  });

  it("handles unicode and emoji in subject", () => {
    const result = parseGitLogLine("abc1234 🚀 日本語 encoding (now)");
    expect(result.subject).toBe("🚀 日本語 encoding");
    expect(result.date).toBe("now");
  });

  it("handles nested parens inside date paren", () => {
    const result = parseGitLogLine("abc1234 something (2 hours ago (approx))");
    expect(result.subject).toBe("something (2 hours ago");
    expect(result.date).toBe("approx)");
  });

  it("handles trailing whitespace after date paren", () => {
    const result = parseGitLogLine("abc1234 fix bug (2 days ago) ");
    expect(result.subject).toBe("fix bug");
    expect(result.date).toBe("2 days ago)");
  });
});

// ─── unquoteGitPath ───

describe("unquoteGitPath", () => {
  it("returns unquoted path unchanged", () => {
    expect(unquoteGitPath("src/file.ts")).toBe("src/file.ts");
  });

  it("strips quotes from quoted path", () => {
    expect(unquoteGitPath('"file with spaces.txt"')).toBe("file with spaces.txt");
  });

  it("unescapes backslash sequences", () => {
    expect(unquoteGitPath('"file\\twith\\ttabs.txt"')).toBe("file\twith\ttabs.txt");
    expect(unquoteGitPath('"has\\nnewline.txt"')).toBe("has\nnewline.txt");
    expect(unquoteGitPath('"escaped\\\\.txt"')).toBe("escaped\\.txt");
    expect(unquoteGitPath('"has\\"quotes\\".txt"')).toBe('has"quotes".txt');
  });

  it("handles empty string", () => {
    expect(unquoteGitPath("")).toBe("");
  });

  it("does not strip single leading quote without trailing", () => {
    expect(unquoteGitPath('"no-close')).toBe('"no-close');
  });

  it("does not strip trailing quote without leading", () => {
    expect(unquoteGitPath('no-open"')).toBe('no-open"');
  });
});

// ─── parseStatusLine ───

describe("parseStatusLine", () => {
  it("parses untracked file", () => {
    const r = parseStatusLine("?? newfile.ts");
    expect(r.category).toBe("untracked");
    expect(r.file).toBe("newfile.ts");
  });

  it("parses staged file (M_)", () => {
    const r = parseStatusLine("M  staged.ts");
    expect(r.category).toBe("staged");
  });

  it("parses modified file (_M)", () => {
    const r = parseStatusLine(" M modified.ts");
    expect(r.category).toBe("modified");
  });

  it("parses both staged and modified (MM) — modified wins", () => {
    const r = parseStatusLine("MM both.ts");
    expect(r.category).toBe("modified");
  });

  it("handles renamed file — extracts destination path", () => {
    const r = parseStatusLine("R  old.ts -> new.ts");
    expect(r.category).toBe("staged");
    expect(r.file).toBe("new.ts");
  });

  it("handles unquoted file with spaces", () => {
    expect(parseStatusLine("?? my file.ts").file).toBe("my file.ts");
  });

  it("handles quoted file with spaces (git quoting)", () => {
    expect(parseStatusLine('?? "file with spaces.txt"').file).toBe("file with spaces.txt");
  });

  it("handles quoted renamed file — extracts unquoted destination", () => {
    const r = parseStatusLine('R  "old name.ts" -> "new name.ts"');
    expect(r.file).toBe("new name.ts");
  });

  it("handles empty line", () => {
    const r = parseStatusLine("");
    expect(r.x).toBe("");
    expect(r.y).toBe("");
    expect(r.file).toBe("");
  });

  it("handles short line (< 3 chars)", () => {
    const r = parseStatusLine("M ");
    expect(r.x).toBe("M");
    expect(r.file).toBe("");
    expect(r.category).toBe("staged");
  });

  it("parses deleted file as staged", () => {
    const r = parseStatusLine("D  deleted.ts");
    expect(r.category).toBe("staged");
  });

  it("parses added file as staged", () => {
    const r = parseStatusLine("A  new.ts");
    expect(r.category).toBe("staged");
  });

  it("UU conflict classified as modified", () => {
    const r = parseStatusLine("UU conflict.ts");
    expect(r.x).toBe("U");
    expect(r.y).toBe("U");
    expect(r.category).toBe("modified");
  });

  it("DD both-deleted classified as modified", () => {
    expect(parseStatusLine("DD deleted-both.ts").category).toBe("modified");
  });

  it("AA both-added classified as modified", () => {
    expect(parseStatusLine("AA added-both.ts").category).toBe("modified");
  });

  it("AU/UA conflict variants classified as modified", () => {
    expect(parseStatusLine("AU file.ts").category).toBe("modified");
    expect(parseStatusLine("UA file.ts").category).toBe("modified");
  });

  it("handles deeply nested directory", () => {
    const r = parseStatusLine(" M src/deep/nested/dir/file.ts");
    expect(r.file).toBe("src/deep/nested/dir/file.ts");
  });

  it("handles worktree-deleted file (AD)", () => {
    expect(parseStatusLine("AD gone.ts").category).toBe("modified");
  });

  it("handles staged rename with worktree modification (RM)", () => {
    expect(parseStatusLine("RM old.ts -> new.ts").category).toBe("modified");
  });
});

// ─── Non-repo graceful degradation ───

describe("git — non-repo directory", () => {
  it("isGitRepo returns false", async () => {
    expect(await isGitRepo(makeTempDir("non-repo"))).toBe(false);
  });

  it("getGitBranch returns null", async () => {
    expect(await getGitBranch(makeTempDir("non-repo-b"))).toBeNull();
  });

  it("getGitStatus returns safe defaults", async () => {
    const s = await getGitStatus(makeTempDir("non-repo-s"));
    expect(s.isRepo).toBe(false);
    expect(s.branch).toBeNull();
    expect(s.isDirty).toBe(false);
    expect(s.staged).toEqual([]);
    expect(s.modified).toEqual([]);
    expect(s.untracked).toEqual([]);
    expect(s.conflicts).toEqual([]);
    expect(s.ahead).toBe(0);
    expect(s.behind).toBe(0);
  });

  it("getGitLog returns empty", async () => {
    expect(await getGitLog(makeTempDir("non-repo-l"))).toEqual([]);
  });

  it("getGitDiff returns empty string", async () => {
    expect(await getGitDiff(makeTempDir("non-repo-d"))).toBe("");
  });

  it("buildGitContext returns null", async () => {
    expect(await buildGitContext(makeTempDir("non-repo-c"))).toBeNull();
  });

  it("gitCommit returns ok: false", async () => {
    expect((await gitCommit(makeTempDir("non-repo-cm"), "test")).ok).toBe(false);
  });

  it("gitAdd returns false", async () => {
    expect(await gitAdd(makeTempDir("non-repo-a"), ["file.txt"])).toBe(false);
  });
});

describe("git — non-existent directory", () => {
  it("isGitRepo returns false", async () => {
    expect(await isGitRepo("/tmp/this-does-not-exist-ever")).toBe(false);
  });

  it("getGitStatus returns safe default", async () => {
    expect((await getGitStatus("/tmp/this-does-not-exist-ever")).isRepo).toBe(false);
  });

  it("run returns ok: false", async () => {
    expect((await run(["status"], "/tmp/this-does-not-exist-ever")).ok).toBe(false);
  });
});

// ─── Empty repo (init, no commits) ───

describe("git — empty repo (no commits)", () => {
  it("getGitLog returns empty on repo with no commits", async () => {
    const dir = await initRepo("empty-log");
    expect(await getGitLog(dir)).toEqual([]);
  });

  it("getGitBranch returns null on repo with no commits (no HEAD)", async () => {
    const dir = await initRepo("empty-branch");
    const branch = await getGitBranch(dir);
    // Before first commit, branch --show-current may return empty or the default
    // Either null or the default branch name is acceptable
    expect(branch === null || branch === "main" || branch === "master").toBe(true);
  });

  it("gitCommit with nothing staged fails", async () => {
    const dir = await initRepo("empty-commit");
    setCoAuthorEnabled(false);
    const result = await gitCommit(dir, "empty commit");
    setCoAuthorEnabled(true);
    expect(result.ok).toBe(false);
  });

  it("getGitStatus on empty repo with untracked file", async () => {
    const dir = await initRepo("empty-untracked");
    writeFileSync(join(dir, "file.txt"), "content");
    const status = await getGitStatus(dir);
    expect(status.isRepo).toBe(true);
    expect(status.isDirty).toBe(true);
    expect(status.untracked).toContain("file.txt");
  });

  it("buildGitContext on empty repo (no commits)", async () => {
    const dir = await initRepo("empty-context");
    const ctx = await buildGitContext(dir);
    expect(ctx).not.toBeNull();
    expect(ctx).toContain("Branch:");
    expect(ctx).toContain("clean");
    expect(ctx).not.toContain("Recent commits:");
  });
});

// ─── Lifecycle: staged, modified, untracked, committed ───

describe("git — full lifecycle", () => {
  let dir: string;

  it("setup repo with initial commit", async () => {
    dir = await initRepoWithCommit("lifecycle", { "hello.txt": "hello world" });
  });

  it("untracked file appears in status", async () => {
    writeFileSync(join(dir, "new.txt"), "new");
    const s = await getGitStatus(dir);
    expect(s.isDirty).toBe(true);
    expect(s.untracked).toContain("new.txt");
  });

  it("gitAdd stages a file", async () => {
    await gitAdd(dir, ["new.txt"]);
    const s = await getGitStatus(dir);
    expect(s.staged).toContain("new.txt");
    expect(s.untracked).not.toContain("new.txt");
  });

  it("getGitDiff staged shows staged changes", async () => {
    const diff = await getGitDiff(dir, true);
    expect(diff).toContain("new");
  });

  it("gitCommit creates a commit", async () => {
    setCoAuthorEnabled(false);
    const result = await gitCommit(dir, "add new file");
    setCoAuthorEnabled(true);
    expect(result.ok).toBe(true);
  });

  it("getGitLog returns commits in order", async () => {
    const log = await getGitLog(dir);
    expect(log.length).toBe(2);
    expect(log[0]?.subject).toBe("add new file");
    expect(log[1]?.subject).toBe("initial");
  });

  it("getGitDiff shows unstaged changes", async () => {
    writeFileSync(join(dir, "hello.txt"), "modified");
    const diff = await getGitDiff(dir);
    expect(diff).toContain("modified");
  });

  it("getGitDiff returns empty when clean", async () => {
    await gitAdd(dir, ["hello.txt"]);
    setCoAuthorEnabled(false);
    await gitCommit(dir, "modify hello");
    setCoAuthorEnabled(true);
    expect(await getGitDiff(dir)).toBe("");
  });
});

// ─── Multiple files, mixed status ───

describe("git — mixed file states", () => {
  it("handles staged + modified + untracked simultaneously", async () => {
    const dir = await initRepoWithCommit("mixed", { "a.txt": "aaa", "b.txt": "bbb" });
    writeFileSync(join(dir, "a.txt"), "aaa modified");
    writeFileSync(join(dir, "b.txt"), "bbb modified");
    await gitAdd(dir, ["b.txt"]);
    writeFileSync(join(dir, "c.txt"), "new");

    const s = await getGitStatus(dir);
    expect(s.isDirty).toBe(true);
    expect(s.modified).toContain("a.txt");
    expect(s.staged).toContain("b.txt");
    expect(s.untracked).toContain("c.txt");
  });

  it("file staged then modified again appears in both lists", async () => {
    const dir = await initRepoWithCommit("staged-then-mod", { "f.txt": "orig" });
    writeFileSync(join(dir, "f.txt"), "staged version");
    await gitAdd(dir, ["f.txt"]);
    writeFileSync(join(dir, "f.txt"), "modified after staging");

    const s = await getGitStatus(dir);
    expect(s.staged).toContain("f.txt");
    expect(s.modified).toContain("f.txt");
  });

  it("deleted file shows as staged", async () => {
    const dir = await initRepoWithCommit("deleted", { "gone.txt": "bye" });
    rmSync(join(dir, "gone.txt"));
    await run(["add", "gone.txt"], dir);

    const s = await getGitStatus(dir);
    expect(s.staged).toContain("gone.txt");
  });
});

// ─── Co-author handling ───

describe("git — co-author handling", () => {
  it("co-author line is appended when enabled", async () => {
    const dir = await initRepoWithCommit("co-on");
    writeFileSync(join(dir, "f.txt"), "content");
    await gitAdd(dir, ["f.txt"]);
    setCoAuthorEnabled(true);
    await gitCommit(dir, "with co-author");
    const { stdout } = await run(["log", "-1", "--format=%B"], dir);
    expect(stdout).toContain("Co-Authored-By: SoulForge");
  });

  it("co-author line is omitted when disabled", async () => {
    const dir = await initRepoWithCommit("co-off");
    writeFileSync(join(dir, "f.txt"), "content");
    await gitAdd(dir, ["f.txt"]);
    setCoAuthorEnabled(false);
    await gitCommit(dir, "without co-author");
    setCoAuthorEnabled(true);
    const { stdout } = await run(["log", "-1", "--format=%B"], dir);
    expect(stdout).not.toContain("Co-Authored-By");
  });
});

// ─── Real merge conflicts ───

describe("git — real merge conflicts", () => {
  it("detects UU conflict after merge", async () => {
    const dir = await initRepoWithCommit("conflict-uu", { "shared.txt": "base content" });

    await gitCreateBranch(dir, "feature");
    writeFileSync(join(dir, "shared.txt"), "feature change");
    await gitAdd(dir, ["shared.txt"]);
    setCoAuthorEnabled(false);
    await gitCommit(dir, "feature change");

    await gitSwitchBranch(dir, "main");
    writeFileSync(join(dir, "shared.txt"), "main change");
    await gitAdd(dir, ["shared.txt"]);
    await gitCommit(dir, "main change");
    setCoAuthorEnabled(true);

    // Attempt merge — will fail with conflict
    const mergeResult = await run(["merge", "feature"], dir);
    expect(mergeResult.ok).toBe(false);

    const status = await getGitStatus(dir);
    expect(status.conflicts).toContain("shared.txt");
    expect(status.conflicts.length).toBe(1);
    // Conflicts should NOT appear in staged or modified
    expect(status.staged).not.toContain("shared.txt");
    expect(status.modified).not.toContain("shared.txt");
  });

  it("detects multiple conflict files", async () => {
    const dir = await initRepoWithCommit("conflict-multi", {
      "a.txt": "base a",
      "b.txt": "base b",
      "c.txt": "no conflict",
    });

    await gitCreateBranch(dir, "feat");
    writeFileSync(join(dir, "a.txt"), "feat a");
    writeFileSync(join(dir, "b.txt"), "feat b");
    await gitAdd(dir, ["a.txt", "b.txt"]);
    setCoAuthorEnabled(false);
    await gitCommit(dir, "feat changes");

    await gitSwitchBranch(dir, "main");
    writeFileSync(join(dir, "a.txt"), "main a");
    writeFileSync(join(dir, "b.txt"), "main b");
    await gitAdd(dir, ["a.txt", "b.txt"]);
    await gitCommit(dir, "main changes");
    setCoAuthorEnabled(true);

    await run(["merge", "feat"], dir);
    const status = await getGitStatus(dir);
    expect(status.conflicts).toContain("a.txt");
    expect(status.conflicts).toContain("b.txt");
    expect(status.conflicts).not.toContain("c.txt");
    expect(status.conflicts.length).toBe(2);
  });

  it("buildGitContext shows conflict warning", async () => {
    const dir = await initRepoWithCommit("conflict-ctx", { "x.txt": "base" });

    await gitCreateBranch(dir, "feat");
    writeFileSync(join(dir, "x.txt"), "feat");
    await gitAdd(dir, ["x.txt"]);
    setCoAuthorEnabled(false);
    await gitCommit(dir, "feat");

    await gitSwitchBranch(dir, "main");
    writeFileSync(join(dir, "x.txt"), "main");
    await gitAdd(dir, ["x.txt"]);
    await gitCommit(dir, "main");
    setCoAuthorEnabled(true);

    await run(["merge", "feat"], dir);
    const ctx = await buildGitContext(dir);
    expect(ctx).toContain("Merge conflicts");
    expect(ctx).toContain("x.txt");
  });

  it("conflicts cleared after resolution", async () => {
    const dir = await initRepoWithCommit("conflict-resolve", { "f.txt": "base" });

    await gitCreateBranch(dir, "feat");
    writeFileSync(join(dir, "f.txt"), "feat version");
    await gitAdd(dir, ["f.txt"]);
    setCoAuthorEnabled(false);
    await gitCommit(dir, "feat");

    await gitSwitchBranch(dir, "main");
    writeFileSync(join(dir, "f.txt"), "main version");
    await gitAdd(dir, ["f.txt"]);
    await gitCommit(dir, "main");

    await run(["merge", "feat"], dir);
    expect((await getGitStatus(dir)).conflicts.length).toBe(1);

    // Resolve: pick a version and add
    writeFileSync(join(dir, "f.txt"), "resolved");
    await gitAdd(dir, ["f.txt"]);
    await gitCommit(dir, "merge resolved");
    setCoAuthorEnabled(true);

    const status = await getGitStatus(dir);
    expect(status.conflicts).toEqual([]);
  });

  it("AA conflict: both branches add same new file", async () => {
    const dir = await initRepoWithCommit("conflict-aa", { "base.txt": "base" });

    await gitCreateBranch(dir, "feat");
    writeFileSync(join(dir, "new.txt"), "feat version");
    await gitAdd(dir, ["new.txt"]);
    setCoAuthorEnabled(false);
    await gitCommit(dir, "feat adds new.txt");

    await gitSwitchBranch(dir, "main");
    writeFileSync(join(dir, "new.txt"), "main version");
    await gitAdd(dir, ["new.txt"]);
    await gitCommit(dir, "main adds new.txt");
    setCoAuthorEnabled(true);

    await run(["merge", "feat"], dir);
    const status = await getGitStatus(dir);
    expect(status.conflicts).toContain("new.txt");
  });
});

// ─── Stash operations ───

describe("git — stash operations", () => {
  it("stash list empty on fresh repo", async () => {
    const dir = await initRepoWithCommit("stash-empty");
    const { ok, entries } = await gitStashList(dir);
    expect(ok).toBe(true);
    expect(entries).toEqual([]);
  });

  it("stash push saves dirty state and restores clean", async () => {
    const dir = await initRepoWithCommit("stash-push", { "f.txt": "original" });
    writeFileSync(join(dir, "f.txt"), "modified");
    const result = await gitStash(dir, "test stash");
    expect(result.ok).toBe(true);
    const s = await getGitStatus(dir);
    expect(s.isDirty).toBe(false);
    expect(readFileSync(join(dir, "f.txt"), "utf-8")).toBe("original");
  });

  it("stash list shows entry with message", async () => {
    const dir = await initRepoWithCommit("stash-list", { "f.txt": "orig" });
    writeFileSync(join(dir, "f.txt"), "modified");
    await gitStash(dir, "my custom message");
    const { entries } = await gitStashList(dir);
    expect(entries.length).toBe(1);
    expect(entries[0]).toContain("my custom message");
  });

  it("stash show returns diff content", async () => {
    const dir = await initRepoWithCommit("stash-show", { "f.txt": "orig" });
    writeFileSync(join(dir, "f.txt"), "stashed content");
    await gitStash(dir);
    const { ok, output } = await gitStashShow(dir, 0);
    expect(ok).toBe(true);
    expect(output).toContain("stashed content");
  });

  it("stash pop restores state", async () => {
    const dir = await initRepoWithCommit("stash-pop", { "f.txt": "orig" });
    writeFileSync(join(dir, "f.txt"), "modified");
    await gitStash(dir);
    expect((await getGitStatus(dir)).isDirty).toBe(false);
    const result = await gitStashPop(dir);
    expect(result.ok).toBe(true);
    expect((await getGitStatus(dir)).isDirty).toBe(true);
    expect(readFileSync(join(dir, "f.txt"), "utf-8")).toBe("modified");
  });

  it("stash pop on empty stash fails", async () => {
    const dir = await initRepoWithCommit("stash-pop-empty");
    expect((await gitStashPop(dir)).ok).toBe(false);
  });

  it("stash drop removes entry", async () => {
    const dir = await initRepoWithCommit("stash-drop", { "f.txt": "orig" });
    writeFileSync(join(dir, "f.txt"), "v1");
    await gitStash(dir, "to drop");
    expect((await gitStashList(dir)).entries.length).toBe(1);
    expect((await gitStashDrop(dir, 0)).ok).toBe(true);
    expect((await gitStashList(dir)).entries).toEqual([]);
  });

  it("stash drop on invalid index fails", async () => {
    const dir = await initRepoWithCommit("stash-drop-bad");
    expect((await gitStashDrop(dir, 99)).ok).toBe(false);
  });

  it("stash show on invalid index fails", async () => {
    const dir = await initRepoWithCommit("stash-show-bad");
    expect((await gitStashShow(dir, 99)).ok).toBe(false);
  });

  it("stash on non-repo fails", async () => {
    expect((await gitStash(makeTempDir("stash-nonrepo"))).ok).toBe(false);
  });

  it("stash list on non-repo fails", async () => {
    expect((await gitStashList(makeTempDir("stashlist-nonrepo"))).ok).toBe(false);
  });

  it("stash when working tree is clean — nothing to stash", async () => {
    const dir = await initRepoWithCommit("stash-clean");
    await gitStash(dir, "nothing here");
    // git stash on clean tree: exit code varies by version but no stash is created
    expect((await gitStashList(dir)).entries).toEqual([]);
  });

  it("stash does NOT capture untracked files by default", async () => {
    const dir = await initRepoWithCommit("stash-untracked", { "tracked.txt": "tracked" });
    writeFileSync(join(dir, "untracked.txt"), "new file");
    await gitStash(dir);
    // Untracked files should still be present after stash
    const s = await getGitStatus(dir);
    expect(s.untracked).toContain("untracked.txt");
  });

  it("multiple stashes stack in LIFO order", async () => {
    const dir = await initRepoWithCommit("stash-multi", { "f.txt": "orig" });
    writeFileSync(join(dir, "f.txt"), "first stash");
    await gitStash(dir, "first");
    writeFileSync(join(dir, "f.txt"), "second stash");
    await gitStash(dir, "second");

    const { entries } = await gitStashList(dir);
    expect(entries.length).toBe(2);
    // Most recent stash is at index 0
    expect(entries[0]).toContain("second");
    expect(entries[1]).toContain("first");
  });

  it("stash drop middle entry reindexes remaining", async () => {
    const dir = await initRepoWithCommit("stash-drop-mid", { "f.txt": "orig" });
    writeFileSync(join(dir, "f.txt"), "s0");
    await gitStash(dir, "oldest");
    writeFileSync(join(dir, "f.txt"), "s1");
    await gitStash(dir, "middle");
    writeFileSync(join(dir, "f.txt"), "s2");
    await gitStash(dir, "newest");

    // Drop middle (index 1)
    await gitStashDrop(dir, 1);
    const { entries } = await gitStashList(dir);
    expect(entries.length).toBe(2);
    expect(entries[0]).toContain("newest");
    expect(entries[1]).toContain("oldest");
  });

  it("stash pop with conflict fails gracefully", async () => {
    const dir = await initRepoWithCommit("stash-pop-conflict", { "f.txt": "base" });
    writeFileSync(join(dir, "f.txt"), "stashed version");
    await gitStash(dir);

    // Modify same file and commit before popping
    writeFileSync(join(dir, "f.txt"), "committed version that conflicts");
    await gitAdd(dir, ["f.txt"]);
    setCoAuthorEnabled(false);
    await gitCommit(dir, "diverge");
    setCoAuthorEnabled(true);

    await gitStashPop(dir);
    // May succeed with merge or fail — either way should not crash
    // If it conflicts, status should show the file as conflicted or modified
    const s = await getGitStatus(dir);
    expect(s.isRepo).toBe(true);
  });
});

// ─── Branch operations ───

describe("git — branch operations", () => {
  it("create branch and auto-switch", async () => {
    const dir = await initRepoWithCommit("br-create");
    const result = await gitCreateBranch(dir, "feature-a");
    expect(result.ok).toBe(true);
    expect(await getGitBranch(dir)).toBe("feature-a");
  });

  it("switch back to default branch", async () => {
    const dir = await initRepoWithCommit("br-switch");
    const { stdout } = await run(["branch", "--show-current"], dir);
    const defaultBranch = stdout.trim();
    await gitCreateBranch(dir, "feature");
    expect(await getGitBranch(dir)).toBe("feature");
    const result = await gitSwitchBranch(dir, defaultBranch);
    expect(result.ok).toBe(true);
    expect(await getGitBranch(dir)).toBe(defaultBranch);
  });

  it("create branch without checkout", async () => {
    const dir = await initRepoWithCommit("br-no-checkout");
    const { stdout } = await run(["branch", "--show-current"], dir);
    const defaultBranch = stdout.trim();
    const result = await gitCreateBranch(dir, "side-branch", false);
    expect(result.ok).toBe(true);
    expect(await getGitBranch(dir)).toBe(defaultBranch);
  });

  it("switch to non-existent branch fails", async () => {
    const dir = await initRepoWithCommit("br-noexist");
    expect((await gitSwitchBranch(dir, "does-not-exist")).ok).toBe(false);
  });

  it("create duplicate branch fails", async () => {
    const dir = await initRepoWithCommit("br-dup");
    await gitCreateBranch(dir, "feat");
    await gitSwitchBranch(dir, "main");
    expect((await gitCreateBranch(dir, "feat")).ok).toBe(false);
  });

  it("branch operations on non-repo fail", async () => {
    const dir = makeTempDir("br-nonrepo");
    expect((await gitCreateBranch(dir, "test")).ok).toBe(false);
    expect((await gitSwitchBranch(dir, "test")).ok).toBe(false);
  });

  it("switch branch with dirty working tree — uncommitted tracked changes block checkout", async () => {
    const dir = await initRepoWithCommit("br-dirty", { "f.txt": "original" });
    await gitCreateBranch(dir, "other");
    await gitSwitchBranch(dir, "main");

    // Make conflicting change: modify file, then try to switch
    // to a branch where the file is different
    writeFileSync(join(dir, "f.txt"), "dirty change on main");
    await gitSwitchBranch(dir, "other");
    // Git may allow checkout if changes don't conflict, or block it
    // Either way we should still be in a valid state
    const branch = await getGitBranch(dir);
    expect(branch !== null).toBe(true);
  });

  it("switch branch with untracked files that don't conflict succeeds", async () => {
    const dir = await initRepoWithCommit("br-untracked");
    await gitCreateBranch(dir, "other");
    await gitSwitchBranch(dir, "main");
    writeFileSync(join(dir, "untracked.txt"), "this is fine");
    const result = await gitSwitchBranch(dir, "other");
    expect(result.ok).toBe(true);
    // Untracked file should persist across branch switch
    expect(readFileSync(join(dir, "untracked.txt"), "utf-8")).toBe("this is fine");
  });

  it("detached HEAD state", async () => {
    const dir = await initRepoWithCommit("br-detached");
    const { stdout } = await run(["rev-parse", "HEAD"], dir);
    const commitHash = stdout.trim();
    await run(["checkout", commitHash], dir);
    const branch = await getGitBranch(dir);
    // Detached HEAD: branch --show-current returns empty
    expect(branch).toBeNull();

    const status = await getGitStatus(dir);
    expect(status.isRepo).toBe(true);
    expect(status.branch).toBeNull();
  });

  it("buildGitContext shows (detached) for detached HEAD", async () => {
    const dir = await initRepoWithCommit("br-detached-ctx");
    const { stdout } = await run(["rev-parse", "HEAD"], dir);
    await run(["checkout", stdout.trim()], dir);
    const ctx = await buildGitContext(dir);
    expect(ctx).toContain("(detached)");
  });

  it("branches with commits on different branches show correct log", async () => {
    const dir = await initRepoWithCommit("br-logs");
    await gitCreateBranch(dir, "feature");
    writeFileSync(join(dir, "feat.txt"), "feature work");
    await gitAdd(dir, ["feat.txt"]);
    setCoAuthorEnabled(false);
    await gitCommit(dir, "feature commit");
    setCoAuthorEnabled(true);

    const featLog = await getGitLog(dir);
    expect(featLog.some((e) => e.subject === "feature commit")).toBe(true);

    await gitSwitchBranch(dir, "main");
    const mainLog = await getGitLog(dir);
    expect(mainLog.some((e) => e.subject === "feature commit")).toBe(false);
  });
});

// ─── buildGitContext — upstream tracking ───

describe("buildGitContext — upstream tracking", () => {
  it("no upstream arrow on local-only repo", async () => {
    const dir = await initRepoWithCommit("ctx-no-upstream");
    const ctx = await buildGitContext(dir);
    expect(ctx).not.toContain("→");
  });

  it("upstream arrow shown when tracking remote", async () => {
    // Create a bare repo as "remote" and clone it
    const bareDir = makeTempDir("ctx-upstream-bare");
    await run(["init", "--bare"], bareDir);

    const cloneDir = makeTempDir("ctx-upstream-clone");
    await run(["clone", bareDir, cloneDir], TMP);
    await run(["config", "user.email", "test@test.com"], cloneDir);
    await run(["config", "user.name", "Test"], cloneDir);
    writeFileSync(join(cloneDir, "f.txt"), "content");
    await gitAdd(cloneDir, ["f.txt"]);
    setCoAuthorEnabled(false);
    await gitCommit(cloneDir, "initial");
    setCoAuthorEnabled(true);
    await run(["push", "-u", "origin", "main"], cloneDir);

    const ctx = await buildGitContext(cloneDir);
    expect(ctx).toContain("→");
    expect(ctx).toContain("origin/main");
  });

  it("ahead/behind counts with remote", async () => {
    const bareDir = makeTempDir("ctx-ahead-bare");
    await run(["init", "--bare"], bareDir);

    const cloneDir = makeTempDir("ctx-ahead-clone");
    await run(["clone", bareDir, cloneDir], TMP);
    await run(["config", "user.email", "test@test.com"], cloneDir);
    await run(["config", "user.name", "Test"], cloneDir);
    writeFileSync(join(cloneDir, "f.txt"), "initial");
    await gitAdd(cloneDir, ["f.txt"]);
    setCoAuthorEnabled(false);
    await gitCommit(cloneDir, "initial");
    await run(["push", "-u", "origin", "main"], cloneDir);

    // Make local commits without pushing
    writeFileSync(join(cloneDir, "f.txt"), "local change");
    await gitAdd(cloneDir, ["f.txt"]);
    await gitCommit(cloneDir, "local only");
    setCoAuthorEnabled(true);

    const status = await getGitStatus(cloneDir);
    expect(status.ahead).toBe(1);
    expect(status.behind).toBe(0);

    const ctx = await buildGitContext(cloneDir);
    expect(ctx).toContain("Ahead: 1 commit(s)");
  });
});

// ─── Special file names and edge cases ───

describe("git — special file names", () => {
  it("files with spaces in names — unquoted correctly", async () => {
    const dir = await initRepoWithCommit("special-spaces", { "normal.txt": "ok" });
    writeFileSync(join(dir, "file with spaces.txt"), "content");
    const s = await getGitStatus(dir);
    expect(s.untracked).toContain("file with spaces.txt");
  });

  it("files in nested untracked directories — git shows dir/ not individual files", async () => {
    const dir = await initRepoWithCommit("special-nested");
    mkdirSync(join(dir, "a", "b", "c"), { recursive: true });
    writeFileSync(join(dir, "a", "b", "c", "deep.txt"), "deep");
    const s = await getGitStatus(dir);
    // git status --porcelain shows untracked directories as "a/" not individual files
    expect(s.untracked.some((f) => f.startsWith("a"))).toBe(true);
  });

  it("dotfiles are tracked", async () => {
    const dir = await initRepoWithCommit("special-dotfile");
    writeFileSync(join(dir, ".hidden"), "secret");
    const s = await getGitStatus(dir);
    expect(s.untracked).toContain(".hidden");
  });

  it("binary file shows in status", async () => {
    const dir = await initRepoWithCommit("special-binary");
    writeFileSync(join(dir, "data.bin"), Buffer.from([0x00, 0xff, 0x42, 0x00]));
    const s = await getGitStatus(dir);
    expect(s.untracked).toContain("data.bin");
  });

  it("symlink shows in status", async () => {
    const dir = await initRepoWithCommit("special-symlink", { "target.txt": "target" });
    try {
      symlinkSync(join(dir, "target.txt"), join(dir, "link.txt"));
      const s = await getGitStatus(dir);
      expect(s.untracked).toContain("link.txt");
    } catch {
      // Symlink creation may fail on some systems — skip gracefully
    }
  });

  it("empty file shows in status", async () => {
    const dir = await initRepoWithCommit("special-empty");
    writeFileSync(join(dir, "empty.txt"), "");
    const s = await getGitStatus(dir);
    expect(s.untracked).toContain("empty.txt");
  });
});

// ─── Commit message edge cases ───

describe("git — commit message edge cases", () => {
  it("commit with single quotes in message", async () => {
    const dir = await initRepoWithCommit("msg-quotes");
    writeFileSync(join(dir, "f.txt"), "v2");
    await gitAdd(dir, ["f.txt"]);
    setCoAuthorEnabled(false);
    const result = await gitCommit(dir, "fix: it's a bug");
    setCoAuthorEnabled(true);
    expect(result.ok).toBe(true);
    const log = await getGitLog(dir);
    expect(log[0]?.subject).toBe("fix: it's a bug");
  });

  it("commit with double quotes in message", async () => {
    const dir = await initRepoWithCommit("msg-dquotes");
    writeFileSync(join(dir, "f.txt"), "v2");
    await gitAdd(dir, ["f.txt"]);
    setCoAuthorEnabled(false);
    const result = await gitCommit(dir, 'fix: remove "bad" code');
    setCoAuthorEnabled(true);
    expect(result.ok).toBe(true);
    const log = await getGitLog(dir);
    expect(log[0]?.subject).toBe('fix: remove "bad" code');
  });

  it("commit with newlines in message — only first line in log subject", async () => {
    const dir = await initRepoWithCommit("msg-newline");
    writeFileSync(join(dir, "f.txt"), "v2");
    await gitAdd(dir, ["f.txt"]);
    setCoAuthorEnabled(false);
    const result = await gitCommit(dir, "first line\n\nsecond paragraph");
    setCoAuthorEnabled(true);
    expect(result.ok).toBe(true);
    const log = await getGitLog(dir);
    expect(log[0]?.subject).toBe("first line");
  });

  it("commit with special chars ($, !, backticks)", async () => {
    const dir = await initRepoWithCommit("msg-special");
    writeFileSync(join(dir, "f.txt"), "v2");
    await gitAdd(dir, ["f.txt"]);
    setCoAuthorEnabled(false);
    const result = await gitCommit(dir, "fix: handle $var and `cmd`");
    setCoAuthorEnabled(true);
    expect(result.ok).toBe(true);
    const log = await getGitLog(dir);
    expect(log[0]?.subject).toContain("$var");
  });

  it("commit with empty message fails", async () => {
    const dir = await initRepoWithCommit("msg-empty");
    writeFileSync(join(dir, "f.txt"), "v2");
    await gitAdd(dir, ["f.txt"]);
    setCoAuthorEnabled(false);
    const result = await gitCommit(dir, "");
    setCoAuthorEnabled(true);
    // git rejects empty commit messages
    expect(result.ok).toBe(false);
  });

  it("commit with unicode emoji message", async () => {
    const dir = await initRepoWithCommit("msg-emoji");
    writeFileSync(join(dir, "f.txt"), "v2");
    await gitAdd(dir, ["f.txt"]);
    setCoAuthorEnabled(false);
    const result = await gitCommit(dir, "🚀 deploy v2.0");
    setCoAuthorEnabled(true);
    expect(result.ok).toBe(true);
    const log = await getGitLog(dir);
    expect(log[0]?.subject).toContain("🚀");
  });
});

// ─── Diff edge cases ───

describe("git — diff edge cases", () => {
  it("diff with binary file", async () => {
    const dir = await initRepoWithCommit("diff-binary", { "data.bin": "initial" });
    writeFileSync(join(dir, "data.bin"), Buffer.from([0x00, 0xff, 0x42]));
    const diff = await getGitDiff(dir);
    // Binary diff should contain something (git shows "Binary files differ" or similar)
    expect(typeof diff).toBe("string");
  });

  it("diff with file deletion", async () => {
    const dir = await initRepoWithCommit("diff-delete", { "gone.txt": "bye" });
    rmSync(join(dir, "gone.txt"));
    const diff = await getGitDiff(dir);
    expect(diff).toContain("gone.txt");
    expect(diff).toContain("-bye");
  });

  it("diff with new file (staged)", async () => {
    const dir = await initRepoWithCommit("diff-new-staged");
    writeFileSync(join(dir, "brand-new.txt"), "hello");
    await gitAdd(dir, ["brand-new.txt"]);
    const diff = await getGitDiff(dir, true);
    expect(diff).toContain("brand-new.txt");
    expect(diff).toContain("+hello");
  });

  it("diff with only whitespace changes", async () => {
    const dir = await initRepoWithCommit("diff-whitespace", { "f.txt": "line1\nline2" });
    writeFileSync(join(dir, "f.txt"), "line1\n  line2");
    const diff = await getGitDiff(dir);
    expect(diff.length).toBeGreaterThan(0);
  });

  it("diff with large file change", async () => {
    const dir = await initRepoWithCommit("diff-large", { "big.txt": "a\n".repeat(100) });
    writeFileSync(join(dir, "big.txt"), "b\n".repeat(100));
    const diff = await getGitDiff(dir);
    expect(diff.length).toBeGreaterThan(0);
  });
});

// ─── getGitLog edge cases ───

describe("git — log edge cases", () => {
  it("getGitLog with count=0 returns empty", async () => {
    const dir = await initRepoWithCommit("log-zero");
    expect(await getGitLog(dir, 0)).toEqual([]);
  });

  it("getGitLog with count=1 returns only latest", async () => {
    const dir = await initRepoWithCommit("log-one", { "f.txt": "v1" });
    writeFileSync(join(dir, "f.txt"), "v2");
    await gitAdd(dir, ["f.txt"]);
    setCoAuthorEnabled(false);
    await gitCommit(dir, "second");
    setCoAuthorEnabled(true);
    const log = await getGitLog(dir, 1);
    expect(log.length).toBe(1);
    expect(log[0]?.subject).toBe("second");
  });

  it("getGitLog count larger than total commits returns all", async () => {
    const dir = await initRepoWithCommit("log-large-count");
    const log = await getGitLog(dir, 1000);
    expect(log.length).toBe(1);
  });
});

// ─── gitAdd edge cases ───

describe("git — gitAdd edge cases", () => {
  it("gitAdd non-existent file fails", async () => {
    const dir = await initRepoWithCommit("add-noexist");
    const ok = await gitAdd(dir, ["nonexistent.txt"]);
    expect(ok).toBe(false);
  });

  it("gitAdd with empty file list succeeds (no-op)", async () => {
    const dir = await initRepoWithCommit("add-empty");
    const ok = await gitAdd(dir, []);
    expect(ok).toBe(true);
  });

  it("gitAdd multiple files at once", async () => {
    const dir = await initRepoWithCommit("add-multi");
    writeFileSync(join(dir, "a.txt"), "a");
    writeFileSync(join(dir, "b.txt"), "b");
    writeFileSync(join(dir, "c.txt"), "c");
    const ok = await gitAdd(dir, ["a.txt", "b.txt", "c.txt"]);
    expect(ok).toBe(true);
    const s = await getGitStatus(dir);
    expect(s.staged).toContain("a.txt");
    expect(s.staged).toContain("b.txt");
    expect(s.staged).toContain("c.txt");
  });
});

// ─── run() edge cases ───

describe("git — run timeout and error handling", () => {
  it("run returns ok: false on very short timeout", async () => {
    const result = await run(["log", "--all", "--oneline"], TMP, 1);
    expect(result.ok).toBe(false);
  });

  it("run returns ok: false for invalid git command", async () => {
    const dir = await initRepo("run-invalid");
    expect((await run(["not-a-real-command"], dir)).ok).toBe(false);
  });

  it("run captures stderr-only commands (stdout empty)", async () => {
    const dir = await initRepo("run-stderr");
    // git status on empty repo produces no stdout via porcelain
    const result = await run(["status", "--porcelain=v1"], dir);
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("");
  });
});

// ─── Subdirectory operations ───

describe("git — operations from subdirectory", () => {
  it("isGitRepo returns true from subdirectory of repo", async () => {
    const dir = await initRepoWithCommit("subdir-repo");
    const sub = join(dir, "src", "deep");
    mkdirSync(sub, { recursive: true });
    expect(await isGitRepo(sub)).toBe(true);
  });

  it("getGitStatus from subdirectory shows repo-wide status", async () => {
    const dir = await initRepoWithCommit("subdir-status", { "root.txt": "root" });
    const sub = join(dir, "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(dir, "root.txt"), "modified at root");
    const status = await getGitStatus(sub);
    expect(status.isRepo).toBe(true);
    expect(status.modified).toContain("root.txt");
  });
});

// ─── Concurrent operations ───

describe("git — concurrent operations", () => {
  it("parallel status + log + diff on same repo", async () => {
    const dir = await initRepoWithCommit("concurrent", { "f.txt": "content" });
    writeFileSync(join(dir, "f.txt"), "changed");

    const [status, log, diff] = await Promise.all([
      getGitStatus(dir),
      getGitLog(dir),
      getGitDiff(dir),
    ]);

    expect(status.isRepo).toBe(true);
    expect(status.modified).toContain("f.txt");
    expect(log.length).toBe(1);
    expect(diff).toContain("changed");
  });

  it("parallel status calls on different repos", async () => {
    const [dir1, dir2] = await Promise.all([
      initRepoWithCommit("conc-a", { "a.txt": "a" }),
      initRepoWithCommit("conc-b", { "b.txt": "b" }),
    ]);

    writeFileSync(join(dir1, "a.txt"), "modified a");

    const [s1, s2] = await Promise.all([
      getGitStatus(dir1),
      getGitStatus(dir2),
    ]);

    expect(s1.isDirty).toBe(true);
    expect(s2.isDirty).toBe(false);
  });
});
