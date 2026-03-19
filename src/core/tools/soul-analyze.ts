import { relative } from "node:path";
import type { ToolResult } from "../../types";
import type { RepoMap } from "../intelligence/repo-map.js";
import { isForbidden } from "../security/forbidden.js";

type AnalyzeAction = "identifier_frequency" | "unused_exports" | "file_profile" | "duplication";

interface SoulAnalyzeArgs {
  action: AnalyzeAction;
  file?: string;
  name?: string;
  limit?: number;
}

export const soulAnalyzeTool = {
  name: "soul_analyze",
  description:
    "AST and soul-map powered codebase analysis. Zero LLM token cost — all computed locally from the indexed database.\n" +
    "Actions:\n" +
    "- identifier_frequency: top N most referenced identifiers across the codebase (which files use them). " +
    "Answers 'most reused variable' instantly. Optional name param to check a specific identifier.\n" +
    "- unused_exports: find exported symbols never imported by any other file. Dead code detection.\n" +
    "- file_profile: dependencies, dependents, blast radius, cochanges, and top symbols for a file. Requires file param.\n" +
    "- duplication: find duplicated code across the codebase. Three tiers: exact structural clones (AST shape hash), " +
    "near-duplicates (>70% token similarity via MinHash), and repeated code fragments (same token patterns across functions). " +
    "Optional file param to check clones of a specific file. Catches patterns invisible to grep.",

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
  const unused = repoMap.getUnusedExports();
  if (unused.length === 0) {
    return {
      success: true,
      output: "No unused exports found (all exports are referenced somewhere).",
    };
  }

  const filtered = unused.filter((u) => isForbidden(u.path) === null).slice(0, limit ?? 50);

  const deadCode = new Map<string, Array<{ name: string; kind: string }>>();
  const unnecessaryExports = new Map<string, Array<{ name: string; kind: string }>>();

  for (const u of filtered) {
    const rel = relative(cwd, `${cwd}/${u.path}`);
    const bucket = u.usedInternally ? unnecessaryExports : deadCode;
    const arr = bucket.get(rel) ?? [];
    arr.push({ name: u.name, kind: u.kind });
    bucket.set(rel, arr);
  }

  const lines: string[] = [];

  if (deadCode.size > 0) {
    const count = [...deadCode.values()].reduce((n, arr) => n + arr.length, 0);
    lines.push(`Dead code (${String(count)} exports with no references anywhere):\n`);
    for (const [file, symbols] of deadCode) {
      lines.push(`  ${file}`);
      for (const s of symbols) {
        lines.push(`    ${s.kind} ${s.name}`);
      }
    }
  }

  if (unnecessaryExports.size > 0) {
    const count = [...unnecessaryExports.values()].reduce((n, arr) => n + arr.length, 0);
    if (lines.length > 0) lines.push("");
    lines.push(
      `Unnecessary exports (${String(count)} — used internally but never imported by other files):\n`,
    );
    for (const [file, symbols] of unnecessaryExports) {
      lines.push(`  ${file}`);
      for (const s of symbols) {
        lines.push(`    ${s.kind} ${s.name}`);
      }
    }
  }

  lines.push(
    "\nNote: re-exports, dynamic imports, and external consumers are not tracked. Verify before removing.",
  );

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
      lines.push(`  ${s.kind} ${s.name}`);
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
