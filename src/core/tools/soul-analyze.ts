import { relative } from "node:path";
import type { ToolResult } from "../../types";
import type { RepoMap } from "../intelligence/repo-map.js";
import { isForbidden } from "../security/forbidden.js";

type AnalyzeAction =
  | "identifier_frequency"
  | "unused_exports"
  | "file_profile"
  | "duplication"
  | "top_files"
  | "packages"
  | "symbols_by_kind";

interface SoulAnalyzeArgs {
  action: AnalyzeAction;
  file?: string;
  name?: string;
  kind?: string;
  limit?: number;
}

export const soulAnalyzeTool = {
  name: "soul_analyze",
  description:
    "AST and soul-map powered codebase analysis. Zero LLM token cost — all computed locally from the indexed database.\n" +
    "Actions:\n" +
    "- identifier_frequency: top N most referenced identifiers across the codebase (which files use them). " +
    "Answers 'most reused variable' instantly. Optional name param to check a specific identifier.\n" +
    "- unused_exports: comprehensive dead code report — dead files, dead barrels, export clusters, test-only exports, scattered dead/unnecessary. Sorted by impact.\n" +
    "- file_profile: dependencies, dependents, blast radius, cochanges, and top symbols for a file. Requires file param.\n" +
    "- duplication: find duplicated code across the codebase. Three tiers: exact structural clones (AST shape hash), " +
    "near-duplicates (>70% token similarity via MinHash), and repeated code fragments (same token patterns across functions). " +
    "Optional file param to check clones of a specific file. Catches patterns invisible to grep.\n" +
    "- top_files: most important files ranked by PageRank. Instant codebase overview.\n" +
    "- packages: external dependencies with usage counts and specifiers. Answers 'what does this project use?'\n" +
    "- symbols_by_kind: all exported symbols of a given kind (interface, class, function, type, enum, trait, struct, etc.). " +
    "Requires kind param. Optional name param to get signature of a specific symbol.",

  createExecute: (repoMap?: RepoMap) => {
    return async (args: SoulAnalyzeArgs): Promise<ToolResult> => {
      if (!repoMap?.isReady) {
        return {
          success: false,
          output: "Soul map not ready. Run scan first.",
          error: "not ready",
        };
      }

      const cwd = process.cwd();

      switch (args.action) {
        case "identifier_frequency":
          return identifierFrequency(repoMap, cwd, args.name, args.limit);
        case "unused_exports":
          return unusedExports(repoMap, cwd, args.limit);
        case "file_profile":
          return fileProfile(repoMap, cwd, args.file);
        case "duplication":
          return duplication(repoMap, cwd, args.file, args.limit);
        case "top_files":
          return topFiles(repoMap, cwd, args.limit);
        case "packages":
          return packages(repoMap, args.name, args.limit);
        case "symbols_by_kind":
          return symbolsByKind(repoMap, cwd, args.kind, args.name, args.limit);
        default:
          return {
            success: false,
            output: `Unknown action: ${String(args.action)}`,
            error: "invalid action",
          };
      }
    };
  },
};

function identifierFrequency(
  repoMap: RepoMap,
  cwd: string,
  name: string | undefined,
  limit: number | undefined,
): ToolResult {
  if (name) {
    const symbols = repoMap.findSymbols(name);
    const freq = repoMap.getIdentifierFrequency(500);
    const match = freq.find((f) => f.name === name);

    const lines: string[] = [`Identifier "${name}":`];

    if (match) {
      lines.push(`  Referenced in ${String(match.fileCount)} files`);
    } else {
      lines.push("  Not found in refs index");
    }

    if (symbols.length > 0) {
      lines.push(`  Defined in ${String(symbols.length)} location(s):`);
      for (const sym of symbols) {
        const rel = relative(cwd, sym.path);
        if (isForbidden(rel) !== null) continue;
        lines.push(`    ${rel} (${sym.kind}, pagerank: ${sym.pagerank.toFixed(3)})`);
      }
    }

    return { success: true, output: lines.join("\n") };
  }

  const entries = repoMap.getIdentifierFrequency(limit ?? 25);
  if (entries.length === 0) {
    return { success: true, output: "No identifiers indexed." };
  }

  const lines = [
    `Top ${String(entries.length)} identifiers by cross-file reference count:\n`,
    ...entries.map(
      (e, i) => `  ${String(i + 1).padStart(3)}. ${e.name} — ${String(e.fileCount)} files`,
    ),
  ];

  return { success: true, output: lines.join("\n") };
}

function unusedExports(repoMap: RepoMap, cwd: string, limit: number | undefined): ToolResult {
  const unused = repoMap.getUnusedExports(limit ?? 500);
  const testOnly = repoMap.getTestOnlyExports();
  const deadBarrels = repoMap.getDeadBarrels();

  if (unused.length === 0 && testOnly.length === 0 && deadBarrels.length === 0) {
    return {
      success: true,
      output: "No unused exports found (all exports are referenced somewhere).",
    };
  }

  const filtered = unused.filter((u) => isForbidden(u.path) === null);

  // Group by file
  interface FileEntry {
    dead: Array<{ name: string; kind: string }>;
    unnecessary: Array<{ name: string; kind: string }>;
    lineCount: number;
  }
  const byFile = new Map<string, FileEntry>();

  for (const u of filtered) {
    const rel = relative(cwd, `${cwd}/${u.path}`);
    if (!byFile.has(rel)) byFile.set(rel, { dead: [], unnecessary: [], lineCount: u.lineCount });
    const entry = byFile.get(rel);
    if (!entry) continue;
    if (u.usedInternally) {
      entry.unnecessary.push({ name: u.name, kind: u.kind });
    } else {
      entry.dead.push({ name: u.name, kind: u.kind });
    }
  }

  // Classify files: dead file = ALL exports are dead (none alive)
  const deadFiles: Array<{
    file: string;
    symbols: Array<{ name: string; kind: string }>;
    lineCount: number;
  }> = [];
  const exportGroups: Array<{
    file: string;
    dead: Array<{ name: string; kind: string }>;
    unnecessary: Array<{ name: string; kind: string }>;
    lineCount: number;
  }> = [];
  const scatteredDead: Array<{ file: string; symbols: Array<{ name: string; kind: string }> }> = [];
  const scatteredUnnecessary: Array<{
    file: string;
    symbols: Array<{ name: string; kind: string }>;
  }> = [];

  for (const [file, entry] of byFile) {
    const totalExported = repoMap.getFileExportCount(file);
    const totalDead = entry.dead.length + entry.unnecessary.length;
    const allDead = totalExported > 0 && totalDead >= totalExported;
    const hasDependents = repoMap.getFileDependents(file).length > 0;

    if (allDead && !hasDependents) {
      deadFiles.push({
        file,
        symbols: [...entry.dead, ...entry.unnecessary],
        lineCount: entry.lineCount,
      });
    } else if (entry.dead.length + entry.unnecessary.length >= 3) {
      exportGroups.push({
        file,
        dead: entry.dead,
        unnecessary: entry.unnecessary,
        lineCount: entry.lineCount,
      });
    } else {
      if (entry.dead.length > 0) scatteredDead.push({ file, symbols: entry.dead });
      if (entry.unnecessary.length > 0)
        scatteredUnnecessary.push({ file, symbols: entry.unnecessary });
    }
  }

  // Sort dead files by line count (biggest cleanup wins first)
  deadFiles.sort((a, b) => b.lineCount - a.lineCount);
  exportGroups.sort(
    (a, b) => b.dead.length + b.unnecessary.length - (a.dead.length + a.unnecessary.length),
  );

  // Test-only exports grouped by file
  const testOnlyByFile = new Map<string, Array<{ name: string; kind: string }>>();
  for (const t of testOnly) {
    if (isForbidden(t.path) !== null) continue;
    const rel = relative(cwd, `${cwd}/${t.path}`);
    const arr = testOnlyByFile.get(rel) ?? [];
    arr.push({ name: t.name, kind: t.kind });
    testOnlyByFile.set(rel, arr);
  }

  const lines: string[] = [];
  let totalDeadLines = 0;

  // ── Dead Files ──
  if (deadFiles.length > 0) {
    lines.push(`Dead files (${String(deadFiles.length)} — all exports unused, no dependents):\n`);
    for (const f of deadFiles) {
      totalDeadLines += f.lineCount;
      lines.push(`  ${f.file}  (${String(f.lineCount)}L, ${String(f.symbols.length)} exports)`);
      for (const s of f.symbols) lines.push(`    ${s.kind} ${s.name}`);
    }
    lines.push("");
  }

  // ── Dead Barrels ──
  const barrelPaths = new Set(deadFiles.map((f) => f.file));
  const liveDeadBarrels = deadBarrels.filter(
    (b) => !barrelPaths.has(relative(cwd, `${cwd}/${b.path}`)),
  );
  if (liveDeadBarrels.length > 0) {
    lines.push(
      `Dead barrels (${String(liveDeadBarrels.length)} — nothing imports through them):\n`,
    );
    for (const b of liveDeadBarrels) {
      const rel = relative(cwd, `${cwd}/${b.path}`);
      lines.push(`  ${rel}  (${String(b.lineCount)}L)`);
    }
    lines.push("");
  }

  // ── Export Groups ──
  if (exportGroups.length > 0) {
    lines.push(
      `Dead export clusters (${String(exportGroups.length)} files with 3+ dead exports):\n`,
    );
    for (const g of exportGroups) {
      const total = g.dead.length + g.unnecessary.length;
      lines.push(`  ${g.file}  (${String(total)} dead, ${String(g.lineCount)}L)`);
      for (const s of g.dead) lines.push(`    ${s.kind} ${s.name}`);
      for (const s of g.unnecessary) lines.push(`    ${s.kind} ${s.name}  (internal-only)`);
    }
    lines.push("");
  }

  // ── Test-Only ──
  if (testOnlyByFile.size > 0) {
    const testCount = [...testOnlyByFile.values()].reduce((n, a) => n + a.length, 0);
    lines.push(`Test-only exports (${String(testCount)} — only imported by test files):\n`);
    for (const [file, symbols] of testOnlyByFile) {
      lines.push(`  ${file}`);
      for (const s of symbols) lines.push(`    ${s.kind} ${s.name}`);
    }
    lines.push("");
  }

  // ── Scattered Dead ──
  if (scatteredDead.length > 0) {
    const count = scatteredDead.reduce((n, s) => n + s.symbols.length, 0);
    lines.push(`Scattered dead exports (${String(count)}):\n`);
    for (const s of scatteredDead) {
      lines.push(`  ${s.file}`);
      for (const sym of s.symbols) lines.push(`    ${sym.kind} ${sym.name}`);
    }
    lines.push("");
  }

  // ── Scattered Unnecessary ──
  if (scatteredUnnecessary.length > 0) {
    const count = scatteredUnnecessary.reduce((n, s) => n + s.symbols.length, 0);
    lines.push(
      `Unnecessary exports (${String(count)} — used internally, export keyword removable):\n`,
    );
    for (const s of scatteredUnnecessary) {
      lines.push(`  ${s.file}`);
      for (const sym of s.symbols) lines.push(`    ${sym.kind} ${sym.name}`);
    }
    lines.push("");
  }

  // ── Summary ──
  const totalDead = filtered.filter((u) => !u.usedInternally).length;
  const totalUnnecessary = filtered.filter((u) => u.usedInternally).length;
  lines.push("───");
  lines.push(
    `Summary: ${String(deadFiles.length)} dead files (${String(totalDeadLines)}L removable), ` +
      `${String(liveDeadBarrels.length)} dead barrels, ` +
      `${String(totalDead)} dead exports, ` +
      `${String(totalUnnecessary)} unnecessary exports, ` +
      `${String(testOnlyByFile.size > 0 ? [...testOnlyByFile.values()].reduce((n, a) => n + a.length, 0) : 0)} test-only`,
  );
  lines.push("\nNote: dynamic imports not tracked. Verify before removing.");

  return { success: true, output: lines.join("\n") };
}

function fileProfile(repoMap: RepoMap, cwd: string, file: string | undefined): ToolResult {
  if (!file) {
    return {
      success: false,
      output: "file param required for file_profile",
      error: "missing file",
    };
  }

  if (isForbidden(file) !== null) {
    return {
      success: false,
      output: `Access denied: "${file}" is blocked for security.`,
      error: "forbidden",
    };
  }

  const relPath = file.startsWith("/") ? relative(cwd, file) : file;

  const deps = repoMap.getFileDependencies(relPath);
  const dependents = repoMap.getFileDependents(relPath);
  const cochanges = repoMap.getFileCoChanges(relPath);
  const blastRadius = repoMap.getFileBlastRadius(relPath);
  const symbols = repoMap.getFileSymbols(relPath);

  if (deps.length === 0 && dependents.length === 0 && symbols.length === 0) {
    return { success: true, output: `"${relPath}" not found in soul map index.` };
  }

  const lines = [`File profile: ${relPath}\n`];

  lines.push(`Blast radius: ${String(blastRadius)} files depend on this`);
  lines.push("");

  if (symbols.length > 0) {
    lines.push(`Exports (${String(symbols.length)}):`);
    for (const s of symbols) {
      const sigs = repoMap.getSymbolSignature(s.name);
      const sig = sigs.find((x) => x.path === relPath || x.path.endsWith(`/${relPath}`));
      lines.push(`  ${sig?.signature ?? `${s.kind} ${s.name}`}`);
    }
    lines.push("");
  }

  if (deps.length > 0) {
    lines.push(`Dependencies (${String(deps.length)}):`);
    for (const d of deps.slice(0, 15)) {
      lines.push(`  ${d.path}`);
    }
    if (deps.length > 15) lines.push(`  ... and ${String(deps.length - 15)} more`);
    lines.push("");
  }

  if (dependents.length > 0) {
    lines.push(`Dependents (${String(dependents.length)}) — files that import from this:`);
    for (const d of dependents.slice(0, 15)) {
      lines.push(`  ${d.path}`);
    }
    if (dependents.length > 15) lines.push(`  ... and ${String(dependents.length - 15)} more`);
    lines.push("");
  }

  if (cochanges.length > 0) {
    lines.push(
      `Co-changes (${String(cochanges.length)}) — files that historically change together:`,
    );
    for (const c of cochanges.slice(0, 10)) {
      lines.push(`  ${c.path} (${String(c.count)} co-commits)`);
    }
    lines.push("");
  }

  return { success: true, output: lines.join("\n") };
}

function duplication(
  repoMap: RepoMap,
  cwd: string,
  file: string | undefined,
  limit: number | undefined,
): ToolResult {
  if (file) {
    if (isForbidden(file) !== null) {
      return {
        success: false,
        output: `Access denied: "${file}" is blocked for security.`,
        error: "forbidden",
      };
    }
    const relPath = file.startsWith("/") ? relative(cwd, file) : file;
    const fileDups = repoMap.getFileDuplicates(relPath);
    if (fileDups.length === 0) {
      return { success: true, output: `No structural clones found for functions in "${relPath}".` };
    }

    const lines = [`Structural clones for functions in ${relPath}:\n`];
    for (const dup of fileDups) {
      lines.push(
        `  ${dup.name} (line ${String(dup.line)}) — ${String(dup.clones.length)} clone(s):`,
      );
      for (const c of dup.clones.slice(0, 10)) {
        lines.push(`    ${c.path}:${String(c.line)} — ${c.name}`);
      }
      if (dup.clones.length > 10) {
        lines.push(`    + ${String(dup.clones.length - 10)} more`);
      }
    }
    return { success: true, output: lines.join("\n") };
  }

  const cap = limit ?? 15;
  const lines: string[] = [];

  const clusters = repoMap.getDuplicateStructures(cap);
  if (clusters.length > 0) {
    lines.push(`Exact structural clones (${String(clusters.length)} groups):\n`);
    for (const cluster of clusters) {
      const memberCount = cluster.members.length;
      lines.push(
        `  Cluster — ${String(memberCount)} ${cluster.kind}s, ${String(cluster.nodeCount)} AST nodes each:`,
      );
      for (const m of cluster.members.slice(0, 8)) {
        lines.push(`    ${m.path}:${String(m.line)}-${String(m.endLine)} — ${m.name}`);
      }
      if (memberCount > 8) {
        lines.push(`    + ${String(memberCount - 8)} more`);
      }
      lines.push("");
    }
  }

  const nearDups = repoMap.getNearDuplicates(0.7, cap);
  if (nearDups.length > 0) {
    lines.push(`Near-duplicates (>70% token similarity, ${String(nearDups.length)} pairs):\n`);
    for (const pair of nearDups) {
      const pct = Math.round(pair.similarity * 100);
      lines.push(
        `  ${String(pct)}% — ${pair.a.path}:${String(pair.a.line)} ${pair.a.name}`,
        `       ↔ ${pair.b.path}:${String(pair.b.line)} ${pair.b.name}`,
        "",
      );
    }
  }

  const fragments = repoMap.getRepeatedFragments(cap);
  if (fragments.length > 0) {
    lines.push(
      `Repeated code fragments (${String(fragments.length)} patterns across multiple functions):\n`,
    );
    for (const frag of fragments) {
      lines.push(`  Pattern — ${String(frag.count)} occurrences:`);
      for (const loc of frag.locations.slice(0, 6)) {
        lines.push(`    ${loc.path}:${String(loc.line)} in ${loc.name}`);
      }
      if (frag.locations.length > 6) {
        lines.push(`    + ${String(frag.locations.length - 6)} more`);
      }
      lines.push("");
    }
  }

  if (lines.length === 0) {
    return { success: true, output: "No duplication detected in the codebase." };
  }

  lines.push("Use read_code to inspect specific pairs and determine if they can be unified.");
  return { success: true, output: lines.join("\n") };
}

function topFiles(repoMap: RepoMap, cwd: string, limit: number | undefined): ToolResult {
  const files = repoMap.getTopFiles(limit ?? 20);
  if (files.length === 0) {
    return { success: true, output: "No files indexed." };
  }

  const lines = [`Top ${String(files.length)} files by importance (PageRank):\n`];
  for (const f of files) {
    if (isForbidden(f.path) !== null) continue;
    const rel = relative(cwd, `${cwd}/${f.path}`);
    lines.push(
      `  ${rel}  ${f.language} ${String(f.lines)}L ${String(f.symbols)} symbols  PR:${f.pagerank.toFixed(3)}`,
    );
  }

  return { success: true, output: lines.join("\n") };
}

function packages(
  repoMap: RepoMap,
  name: string | undefined,
  limit: number | undefined,
): ToolResult {
  if (name) {
    const files = repoMap.getFilesByPackage(name);
    if (files.length === 0) {
      return { success: true, output: `No files import "${name}" (or package not indexed).` };
    }

    const lines = [`${String(files.length)} files import "${name}":\n`];
    for (const f of files) {
      if (isForbidden(f.path) !== null) continue;
      const specs = f.specifiers ? ` — ${f.specifiers}` : "";
      lines.push(`  ${f.path}${specs}`);
    }
    return { success: true, output: lines.join("\n") };
  }

  const pkgs = repoMap.getExternalPackages(limit ?? 20);
  if (pkgs.length === 0) {
    return { success: true, output: "No external packages detected." };
  }

  const lines = [`${String(pkgs.length)} external packages:\n`];
  for (const p of pkgs) {
    const specs = p.specifiers.length > 0 ? ` — ${p.specifiers.join(", ")}` : "";
    lines.push(`  ${p.package} (${String(p.fileCount)} files)${specs}`);
  }

  return { success: true, output: lines.join("\n") };
}

function symbolsByKind(
  repoMap: RepoMap,
  cwd: string,
  kind: string | undefined,
  name: string | undefined,
  limit: number | undefined,
): ToolResult {
  if (name) {
    const sigs = repoMap.getSymbolSignature(name);
    if (sigs.length === 0) {
      return { success: true, output: `Symbol "${name}" not found in index.` };
    }

    const lines = [`Symbol "${name}":\n`];
    for (const s of sigs) {
      if (isForbidden(s.path) !== null) continue;
      const rel = relative(cwd, `${cwd}/${s.path}`);
      const sig = s.signature ? `  ${s.signature}` : "";
      lines.push(`  ${rel}:${String(s.line)} (${s.kind})${sig}`);
    }
    return { success: true, output: lines.join("\n") };
  }

  if (!kind) {
    return {
      success: false,
      output:
        "kind param required (e.g., interface, class, function, type, enum, trait, struct). Use name param to look up a specific symbol's signature.",
      error: "missing kind",
    };
  }

  const symbols = repoMap.getSymbolsByKind(kind, limit ?? 30);
  if (symbols.length === 0) {
    return { success: true, output: `No exported ${kind} symbols found.` };
  }

  const lines = [`${String(symbols.length)} exported ${kind} symbols:\n`];
  for (const s of symbols) {
    if (isForbidden(s.path) !== null) continue;
    const rel = relative(cwd, `${cwd}/${s.path}`);
    const sig = s.signature ?? s.name;
    lines.push(`  ${rel}:${String(s.line)}  ${sig}`);
  }

  return { success: true, output: lines.join("\n") };
}
