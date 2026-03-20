export type DiffLineKind = "add" | "remove" | "context" | "collapsed";

export interface DiffLine {
  kind: DiffLineKind;
  content: string;
  oldNum?: number;
  newNum?: number;
  collapsedCount?: number;
}

export interface DiffResult {
  lines: DiffLine[];
  added: number;
  removed: number;
  isCreation: boolean;
}

function lcs(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;

  // Guard: if matrix too large, skip LCS — treat as full remove + full add
  if (n * m > 100_000) {
    const out: DiffLine[] = [];
    for (let i = 0; i < n; i++) {
      out.push({ kind: "remove", content: a[i] ?? "", oldNum: i + 1 });
    }
    for (let j = 0; j < m; j++) {
      out.push({ kind: "add", content: b[j] ?? "", newNum: j + 1 });
    }
    return out;
  }

  // Build DP table
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from({ length: m + 1 }, () => 0),
  );

  for (let i = 1; i <= n; i++) {
    const row = dp[i];
    if (!row) continue;
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        row[j] = (dp[i - 1]?.[j - 1] ?? 0) + 1;
      } else {
        row[j] = Math.max(dp[i - 1]?.[j] ?? 0, row[j - 1] ?? 0);
      }
    }
  }

  // Backtrack
  const result: DiffLine[] = [];
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.push({
        kind: "context",
        content: a[i - 1] ?? "",
        oldNum: i,
        newNum: j,
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || (dp[i]?.[j - 1] ?? 0) >= (dp[i - 1]?.[j] ?? 0))) {
      result.push({ kind: "add", content: b[j - 1] ?? "", newNum: j });
      j--;
    } else {
      result.push({ kind: "remove", content: a[i - 1] ?? "", oldNum: i });
      i--;
    }
  }

  result.reverse();
  return result;
}

function collapseContext(lines: DiffLine[], keepFirst: number, keepLast: number): DiffLine[] {
  // Find runs of consecutive context lines and collapse middles
  const result: DiffLine[] = [];
  let contextRun: DiffLine[] = [];

  const flushRun = () => {
    if (contextRun.length <= keepFirst + keepLast + 1) {
      // Too short to collapse — keep all
      result.push(...contextRun);
    } else {
      // Keep first N, collapse middle, keep last N
      for (let k = 0; k < keepFirst; k++) {
        const item = contextRun[k];
        if (item) result.push(item);
      }
      result.push({
        kind: "collapsed",
        content: "",
        collapsedCount: contextRun.length - keepFirst - keepLast,
      });
      for (let k = contextRun.length - keepLast; k < contextRun.length; k++) {
        const item = contextRun[k];
        if (item) result.push(item);
      }
    }
    contextRun = [];
  };

  for (const line of lines) {
    if (line.kind === "context") {
      contextRun.push(line);
    } else {
      if (contextRun.length > 0) flushRun();
      result.push(line);
    }
  }
  if (contextRun.length > 0) flushRun();

  return result;
}

export function computeDiff(oldString: string, newString: string, startLine = 1): DiffResult {
  const isCreation = oldString === "";

  if (isCreation) {
    const newLines = newString.split("\n");
    let lines: DiffLine[] = newLines.map((content, i) => ({
      kind: "add" as const,
      content,
      newNum: i + 1,
    }));

    // For creations with >10 lines: first 3 + collapsed + last 2
    if (lines.length > 10) {
      const collapsed: DiffLine[] = [];
      for (let i = 0; i < 3; i++) {
        const item = lines[i];
        if (item) collapsed.push(item);
      }
      collapsed.push({
        kind: "collapsed",
        content: "",
        collapsedCount: lines.length - 5,
      });
      for (let i = lines.length - 2; i < lines.length; i++) {
        const item = lines[i];
        if (item) collapsed.push(item);
      }
      lines = collapsed;
    }

    return { lines, added: newLines.length, removed: 0, isCreation: true };
  }

  const oldLines = oldString.split("\n");
  const newLines = newString.split("\n");
  const rawDiff = lcs(oldLines, newLines);

  let added = 0;
  let removed = 0;
  for (const line of rawDiff) {
    if (line.kind === "add") added++;
    if (line.kind === "remove") removed++;
  }

  // Collapse context: runs of >5 context → keep 2 + collapsed + 2
  const lines = collapseContext(rawDiff, 2, 2);

  // Apply start line offset for real file line numbers
  if (startLine > 1) {
    const offset = startLine - 1;
    for (const line of lines) {
      if (line.oldNum != null) line.oldNum += offset;
      if (line.newNum != null) line.newNum += offset;
    }
  }

  return { lines, added, removed, isCreation: false };
}

const EXT_MAP: Record<string, string> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".jsx": "jsx",
  ".py": "python",
  ".sh": "bash",
  ".zsh": "bash",
  ".bash": "bash",
  ".go": "go",
  ".rs": "rust",
  ".json": "json",
  ".css": "css",
  ".scss": "css",
};

export function langFromPath(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return "";
  const ext = filePath.slice(dot).toLowerCase();
  return EXT_MAP[ext] ?? "";
}
