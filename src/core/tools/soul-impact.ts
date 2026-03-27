import { relative } from "node:path";
import type { ToolResult } from "../../types";
import { isForbidden } from "../security/forbidden.js";
import type { IntelligenceClient } from "../workers/intelligence-client.js";

type ImpactAction = "dependents" | "dependencies" | "cochanges" | "blast_radius";

interface SoulImpactArgs {
  action: ImpactAction;
  file: string;
}

export const soulImpactTool = {
  name: "soul_impact",
  description: "Dependency graph queries: dependents, dependencies, cochanges, blast_radius.",

  createExecute: (repoMap?: IntelligenceClient) => {
    return async (args: SoulImpactArgs): Promise<ToolResult> => {
      if (!repoMap?.isReady) {
        return { success: false, output: "Soul map not ready.", error: "not ready" };
      }

      if (isForbidden(args.file) !== null) {
        return {
          success: false,
          output: `Access denied: "${args.file}" is blocked for security.`,
          error: "forbidden",
        };
      }

      const cwd = process.cwd();
      const relPath = args.file.startsWith("/") ? relative(cwd, args.file) : args.file;

      switch (args.action) {
        case "dependents":
          return await showDependents(repoMap, relPath);
        case "dependencies":
          return await showDependencies(repoMap, relPath);
        case "cochanges":
          return await showCoChanges(repoMap, relPath);
        case "blast_radius":
          return await showBlastRadius(repoMap, relPath);
        default:
          return {
            success: false,
            output: `Unknown action: ${String(args.action)}`,
            error: "invalid",
          };
      }
    };
  },
};

async function showDependents(repoMap: IntelligenceClient, relPath: string): Promise<ToolResult> {
  const dependents = await repoMap.getFileDependents(relPath);
  if (dependents.length === 0) {
    return { success: true, output: `No files depend on "${relPath}" (or file not indexed).` };
  }

  const lines = [
    `${String(dependents.length)} files import from "${relPath}":\n`,
    ...dependents.filter((d) => isForbidden(d.path) === null).map((d) => `  ${d.path}`),
  ];

  return { success: true, output: lines.join("\n") };
}

async function showDependencies(repoMap: IntelligenceClient, relPath: string): Promise<ToolResult> {
  const deps = await repoMap.getFileDependencies(relPath);
  if (deps.length === 0) {
    return {
      success: true,
      output: `"${relPath}" has no tracked dependencies (or file not indexed).`,
    };
  }

  const lines = [
    `"${relPath}" imports from ${String(deps.length)} files:\n`,
    ...deps.filter((d) => isForbidden(d.path) === null).map((d) => `  ${d.path}`),
  ];

  return { success: true, output: lines.join("\n") };
}

async function showCoChanges(repoMap: IntelligenceClient, relPath: string): Promise<ToolResult> {
  const cochanges = await repoMap.getFileCoChanges(relPath);
  if (cochanges.length === 0) {
    return { success: true, output: `No co-change partners found for "${relPath}".` };
  }

  const lines = [
    `Files that historically change together with "${relPath}":\n`,
    ...cochanges
      .filter((c) => isForbidden(c.path) === null)
      .map((c) => `  ${c.path} (${String(c.count)} co-commits)`),
  ];

  return { success: true, output: lines.join("\n") };
}

async function showBlastRadius(repoMap: IntelligenceClient, relPath: string): Promise<ToolResult> {
  const dependents = await repoMap.getFileDependents(relPath);
  const cochanges = await repoMap.getFileCoChanges(relPath);
  const blastCount = await repoMap.getFileBlastRadius(relPath);
  const symbols = await repoMap.getFileSymbols(relPath);

  if (dependents.length === 0 && cochanges.length === 0 && symbols.length === 0) {
    return { success: true, output: `"${relPath}" not found in soul map index.` };
  }

  const allAffected = new Set<string>();
  for (const d of dependents) allAffected.add(d.path);
  for (const c of cochanges) allAffected.add(c.path);

  const lines = [
    `Blast radius for "${relPath}":\n`,
    `  Direct dependents: ${String(blastCount)}`,
    `  Co-change partners: ${String(cochanges.length)}`,
    `  Total affected files: ${String(allAffected.size)}`,
  ];

  if (symbols.length > 0) {
    lines.push(`\nExported symbols (${String(symbols.length)}):`);
    for (const s of symbols) {
      lines.push(`  ${s.kind} ${s.name}`);
    }
  }

  if (dependents.length > 0) {
    lines.push(`\nDirect dependents (${String(dependents.length)}):`);
    for (const d of dependents.filter((d) => isForbidden(d.path) === null).slice(0, 20)) {
      lines.push(`  ${d.path}`);
    }
    if (dependents.length > 20) lines.push(`  ... and ${String(dependents.length - 20)} more`);
  }

  if (cochanges.length > 0) {
    const coOnly = cochanges.filter(
      (c) => !dependents.some((d) => d.path === c.path) && isForbidden(c.path) === null,
    );
    if (coOnly.length > 0) {
      lines.push(`\nCo-change only (related by git history, not imports):`);
      for (const c of coOnly.slice(0, 10)) {
        lines.push(`  ${c.path} (${String(c.count)} co-commits)`);
      }
    }
  }

  return { success: true, output: lines.join("\n") };
}
