import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { CodeIntelligenceRouter } from "./router.js";
import type { CodeAction, Diagnostic, Language } from "./types.js";

interface NewDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: Diagnostic["severity"];
  message: string;
  code?: string | number;
  fixes: string[];
}

interface PostEditResult {
  newErrors: NewDiagnostic[];
  newWarnings: NewDiagnostic[];
  resolved: number;
  crossFileErrors: NewDiagnostic[];
}

export async function postEditDiagnostics(
  router: CodeIntelligenceRouter,
  filePath: string,
  language: Language,
  beforeDiags: Diagnostic[],
): Promise<PostEditResult> {
  const result: PostEditResult = {
    newErrors: [],
    newWarnings: [],
    resolved: 0,
    crossFileErrors: [],
  };

  // Get after-edit diagnostics
  const afterDiags = await router.executeWithFallback(language, "getDiagnostics", (b) =>
    b.getDiagnostics ? b.getDiagnostics(filePath) : Promise.resolve(null),
  );

  if (!afterDiags) return result;

  // Diff: find new diagnostics not present before
  const newDiags = afterDiags.filter(
    (after) =>
      !beforeDiags.some(
        (before) =>
          before.line === after.line &&
          before.message === after.message &&
          before.severity === after.severity,
      ),
  );

  // Find resolved diagnostics
  const resolvedDiags = beforeDiags.filter(
    (before) =>
      before.severity === "error" &&
      !afterDiags.some(
        (after) =>
          after.line === before.line &&
          after.message === before.message &&
          after.severity === before.severity,
      ),
  );
  result.resolved = resolvedDiags.length;

  // For each new diagnostic, check for available code actions (quick-fixes)
  for (const diag of newDiags) {
    const fixes = await getFixesForDiagnostic(router, filePath, language, diag);
    const entry: NewDiagnostic = {
      file: filePath,
      line: diag.line,
      column: diag.column,
      severity: diag.severity,
      message: diag.message,
      code: diag.code,
      fixes,
    };
    if (diag.severity === "error") {
      result.newErrors.push(entry);
    } else if (diag.severity === "warning") {
      result.newWarnings.push(entry);
    }
  }

  // Cross-file: find importers and check for new errors
  const importers = findImporters(filePath);
  for (const importer of importers.slice(0, 5)) {
    const importerLang = router.detectLanguage(importer);
    const importerDiags = await router.executeWithFallback(importerLang, "getDiagnostics", (b) =>
      b.getDiagnostics ? b.getDiagnostics(importer) : Promise.resolve(null),
    );
    if (!importerDiags) continue;
    const importerErrors = importerDiags.filter((d) => d.severity === "error");
    for (const err of importerErrors) {
      const fixes = await getFixesForDiagnostic(router, importer, importerLang, err);
      result.crossFileErrors.push({
        file: importer,
        line: err.line,
        column: err.column,
        severity: err.severity,
        message: err.message,
        code: err.code,
        fixes,
      });
    }
  }

  return result;
}

async function getFixesForDiagnostic(
  router: CodeIntelligenceRouter,
  file: string,
  language: Language,
  diag: Diagnostic,
): Promise<string[]> {
  const codeActions = await router.executeWithFallback(language, "getCodeActions", (b) => {
    if (!b.getCodeActions) return Promise.resolve(null);
    const codes = diag.code !== undefined ? [diag.code] : undefined;
    return b.getCodeActions(file, diag.line, diag.line, codes);
  });
  if (!codeActions) return [];
  return codeActions
    .filter((a: CodeAction) => a.kind === "quickfix" || a.isPreferred)
    .map((a: CodeAction) => a.title)
    .slice(0, 3);
}

function findImporters(filePath: string): string[] {
  const absPath = resolve(filePath);
  const dir = dirname(absPath);
  const base = basename(absPath).replace(/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/, "");

  // Look for files in the same project that import this file
  // Use a fast grep-like scan on common import patterns
  const importPatterns = [
    `from "./${base}"`,
    `from './${base}'`,
    `from "../${basename(dir)}/${base}"`,
    `from '../${basename(dir)}/${base}'`,
    `require("./${base}")`,
    `require('./${base}')`,
  ];

  const importers: string[] = [];
  try {
    scanForImporters(dirname(absPath), absPath, importPatterns, importers, 0);
  } catch {
    // Best effort
  }
  return importers;
}

function scanForImporters(
  searchDir: string,
  targetFile: string,
  patterns: string[],
  results: string[],
  depth: number,
): void {
  if (depth > 3 || results.length >= 5) return;
  const { readdirSync } = require("node:fs") as typeof import("node:fs");

  try {
    for (const entry of readdirSync(searchDir, { withFileTypes: true })) {
      if (results.length >= 5) return;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

      const fullPath = resolve(searchDir, entry.name);
      if (entry.isDirectory() && depth < 2) {
        scanForImporters(fullPath, targetFile, patterns, results, depth + 1);
      } else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        if (fullPath === targetFile) continue;
        try {
          const content = readFileSync(fullPath, "utf-8");
          if (patterns.some((p) => content.includes(p))) {
            results.push(fullPath);
          }
        } catch {
          // Skip unreadable
        }
      }
    }
  } catch {
    // Skip unreadable dirs
  }
}

export function formatPostEditResult(result: PostEditResult): string | null {
  const parts: string[] = [];

  if (result.resolved > 0) {
    parts.push(`✓ ${String(result.resolved)} error(s) resolved`);
  }

  if (result.newErrors.length > 0) {
    parts.push(`⚠ ${String(result.newErrors.length)} new error(s):`);
    for (const e of result.newErrors.slice(0, 5)) {
      const code = e.code ? ` [${String(e.code)}]` : "";
      parts.push(`  L${String(e.line)}${code}: ${e.message}`);
      if (e.fixes.length > 0) {
        parts.push(`    fix: ${e.fixes[0]}`);
      }
    }
    if (result.newErrors.length > 5) {
      parts.push(`  ...and ${String(result.newErrors.length - 5)} more`);
    }
  }

  if (result.crossFileErrors.length > 0) {
    parts.push(`⚠ ${String(result.crossFileErrors.length)} cross-file error(s):`);
    for (const e of result.crossFileErrors.slice(0, 3)) {
      const code = e.code ? ` [${String(e.code)}]` : "";
      const short = basename(e.file);
      parts.push(`  ${short}:${String(e.line)}${code}: ${e.message}`);
      if (e.fixes.length > 0) {
        parts.push(`    fix: ${e.fixes[0]}`);
      }
    }
    if (result.crossFileErrors.length > 3) {
      parts.push(`  ...and ${String(result.crossFileErrors.length - 3)} more`);
    }
  }

  if (result.newWarnings.length > 0 && result.newErrors.length === 0) {
    parts.push(`△ ${String(result.newWarnings.length)} new warning(s)`);
  }

  return parts.length > 0 ? parts.join("\n") : null;
}
