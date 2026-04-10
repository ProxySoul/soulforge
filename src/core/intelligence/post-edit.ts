import { basename } from "node:path";
import { getIntelligenceClient } from "./index.js";
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

/**
 * Lightweight same-file-only diagnostics for the edit hot path.
 * Skips the expensive cross-file findImporters scan that does recursive
 * readdir + readFile on the main thread — that blocks the UI when
 * multiple edits are in-flight.
 */
export async function sameFileDiagnostics(
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

  let afterDiags: Diagnostic[] | null;
  const client = getIntelligenceClient();
  if (client) {
    const tracked = await client.routerGetDiagnostics(filePath);
    afterDiags = tracked?.value ?? null;
  } else {
    afterDiags = await router.executeWithFallback(language, "getDiagnostics", (b) =>
      b.getDiagnostics ? b.getDiagnostics(filePath) : Promise.resolve(null),
    );
  }

  if (!afterDiags) return result;

  const newDiags = afterDiags.filter(
    (after) =>
      !beforeDiags.some(
        (before) =>
          before.line === after.line &&
          before.message === after.message &&
          before.severity === after.severity,
      ),
  );

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

  return result;
}

async function getFixesForDiagnostic(
  router: CodeIntelligenceRouter,
  file: string,
  language: Language,
  diag: Diagnostic,
): Promise<string[]> {
  const client = getIntelligenceClient();
  let codeActions: CodeAction[] | null;
  if (client) {
    const tracked = await client.routerGetCodeActions(file, diag.line, diag.line);
    codeActions = tracked?.value ?? null;
  } else {
    codeActions = await router.executeWithFallback(language, "getCodeActions", (b) => {
      if (!b.getCodeActions) return Promise.resolve(null);
      const codes = diag.code !== undefined ? [diag.code] : undefined;
      return b.getCodeActions(file, diag.line, diag.line, codes);
    });
  }
  if (!codeActions) return [];
  return codeActions
    .filter((a: CodeAction) => a.kind === "quickfix" || a.isPreferred)
    .map((a: CodeAction) => a.title)
    .slice(0, 3);
}

export function formatPostEditResult(result: PostEditResult): string | null {
  const parts: string[] = [];

  if (result.resolved > 0) {
    parts.push(`✓ ${String(result.resolved)} error(s) resolved`);
  }

  const totalErrors = result.newErrors.length + result.crossFileErrors.length;

  if (result.newErrors.length > 0) {
    parts.push(`❌ ERRORS INTRODUCED — ${String(result.newErrors.length)} new error(s):`);
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
    parts.push(
      `❌ CROSS-FILE ERRORS — ${String(result.crossFileErrors.length)} error(s) in other files:`,
    );
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

  if (totalErrors > 0) {
    parts.push("⛔ FIX THESE ERRORS before continuing with other work.");
  }

  if (result.newWarnings.length > 0 && totalErrors === 0) {
    parts.push(`△ ${String(result.newWarnings.length)} new warning(s)`);
  }

  return parts.length > 0 ? parts.join("\n") : null;
}
