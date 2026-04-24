import { mkdir, readFile, stat as statAsync, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ToolResult } from "../../types/index.js";
import { analyzeFile } from "../analysis/complexity.js";
import { markToolWrite, reloadBuffer } from "../editor/instance.js";
import type { SurgicalOperation } from "../intelligence/backends/ts-morph.js";
import { TsMorphBackend } from "../intelligence/backends/ts-morph.js";
import { isForbidden } from "../security/forbidden.js";
import { displayPath } from "../utils/path-display.js";
import { formatMetricDelta } from "./edit-file.js";
import { pushEdit } from "./edit-stack.js";
import { emitFileEdited } from "./file-events.js";
import {
  appendAutoFormatResult,
  appendCloneHints,
  appendPostEditDiagnostics,
  startPreEditDiagnostics,
} from "./post-edit-helpers.js";
import { consumeAstEditNudge } from "./ts-project-detect.js";

const SUPPORTED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
]);

function isSupportedFile(filePath: string): boolean {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return false;
  return SUPPORTED_EXTENSIONS.has(filePath.slice(dot));
}

interface AstEditArgs {
  path: string;
  // Single operation (flat args)
  action?: string;
  target?: string;
  name?: string;
  value?: string;
  newCode?: string;
  index?: number;
  // Multi-operation atomic mode
  operations?: SurgicalOperation[];
  tabId?: string;
}

/** Shared backend instance — lazily initialized, reused across calls. */
let _backend: TsMorphBackend | null = null;

function getBackend(cwd: string): TsMorphBackend {
  if (!_backend) {
    _backend = new TsMorphBackend();
    _backend.initialize(cwd);
  }
  return _backend;
}

/**
 * 100% ts-morph surgical AST editing for TypeScript/JavaScript files.
 * Inspired by Ouail Bni's Master's thesis "Typed vs Untyped Programming Languages" (2022).
 *
 * Three tiers of operations — from micro-edit to full replacement:
 *
 * Tier 1 — Surgical (1-10 tokens): set_type, set_return_type, set_initializer,
 *   set_async, set_export, rename, remove, add_parameter, remove_parameter, set_optional
 *
 * Tier 2 — Body surgery (10-100 tokens): set_body, add_statement, insert_statement,
 *   remove_statement, add_property, remove_property, add_method, add_member, remove_member
 *
 * Tier 3 — Full replacement: replace (whole symbol)
 *
 * File-level: add_import, remove_import, organize_imports, fix_missing_imports, fix_unused,
 *   add_function, add_class, add_interface, add_type_alias, add_enum
 *
 * Zero string matching. Zero line math. Zero oldString.
 * ts-morph handles locate → mutate → serialize entirely.
 */
export const astEditTool = {
  name: "ast_edit",
  description:
    "AST edit for TS/JS (.ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs). Default editor for these files — ts-morph locates symbols by {target, name}, no oldString, no line drift. " +
    "Single op: {action, target, name, value?, newCode?, index?}. " +
    "Multi-op (atomic, same file): {operations:[{...}, ...]} — all-or-nothing rollback. " +
    "Create files: action='create_file', newCode=<full content>. " +
    "Targets: function|class|interface|type|enum|variable|method|property|constructor|arrow_function. " +
    "Class members: name='ClassName.memberName' or just 'memberName'. Arrow const: target='arrow_function', name='foo'. " +
    "Idempotent: add_import/add_named_import/add_named_reexport merge; add_constructor modifies in place. " +
    "replace_in_body is whitespace-tolerant (tab↔space, CRLF, indent drift auto-handled) and supports anchor-pair range mode: pass value=<short unique start anchor> + valueEnd=<short unique end anchor> to replace the span between them — rewrite a 100-line block with ~20 tokens. " +
    "Body shape — critical: set_body/add_statement/insert_statement take body CONTENTS ONLY (no surrounding {}, ts-morph wraps). " +
    "add_method/add_constructor/add_getter/add_setter take the FULL declaration INCLUDING braces (e.g. 'foo(x: number) { return x; }'). " +
    "replace takes the WHOLE symbol text including braces. " +
    "add_property on interface: 'name: type' or 'name?: type'; on class: 'name: type = value' or 'name = value'. " +
    "Import ops: value=module specifier (e.g. 'zod'), newCode=comma-separated names (e.g. 'z' or 'useState,useEffect'); remove_named_import uses value=module and name=single identifier. " +
    "Safe defaults: rename = declaration-only; use rename_global or rename_symbol for project-wide. " +
    "CANNOT target anonymous callbacks or union members inside a type alias — use replace on the whole symbol, or replace_in_body for AST-anchored text tweaks. " +
    "insert_text requires an anchor (index=0|-1 or value='after-imports'|'before-exports'). " +
    "See the <ast_edit> section of the system tool_usage block for the full operation taxonomy and examples.",
  execute: async (args: AstEditArgs): Promise<ToolResult> => {
    try {
      const filePath = resolve(args.path);

      const blocked = isForbidden(filePath);
      if (blocked) {
        const msg = `Access denied: "${args.path}" matches forbidden pattern "${blocked}".`;
        return { success: false, output: msg, error: msg };
      }

      if (!isSupportedFile(filePath)) {
        const msg = `ast_edit only supports TS/JS files. Use edit_file for "${args.path}".`;
        return { success: false, output: msg, error: "unsupported file type" };
      }

      // Normalize: flat single-op args OR operations array
      let ops: SurgicalOperation[];
      if (args.operations && args.operations.length > 0) {
        ops = args.operations;
      } else if (args.action) {
        ops = [
          {
            action: args.action,
            target: args.target,
            name: args.name,
            value: args.value,
            newCode: args.newCode,
            index: args.index,
          },
        ];
      } else {
        const msg =
          "Provide action (+ target/name/value/newCode) for a single operation, " +
          "or an operations array for multiple atomic operations.";
        return { success: false, output: msg, error: "missing parameters" };
      }

      // ── Fast path: create_file ────────────────────────────────────────
      // Must be the sole operation — creating a file that already exists is an
      // error (use a regular ast_edit for modifications).
      if (ops.length === 1 && ops[0]?.action === "create_file") {
        const op = ops[0];
        const content = op.newCode ?? "";
        let exists = false;
        try {
          await statAsync(filePath);
          exists = true;
        } catch {
          exists = false;
        }
        if (exists) {
          const msg = `File already exists: ${filePath}. Use ast_edit with a non-create_file action to modify it.`;
          return { success: false, output: msg, error: "file exists" };
        }
        try {
          await mkdir(dirname(filePath), { recursive: true });
          const beforeMetrics = analyzeFile("");
          const afterMetrics = analyzeFile(content);
          const diagsPromise = startPreEditDiagnostics(filePath);

          pushEdit(filePath, "", content, args.tabId);
          await writeFile(filePath, content, "utf-8");
          markToolWrite(filePath);
          emitFileEdited(filePath, content);
          reloadBuffer(filePath, 1).catch(() => {});

          const deltas = [
            formatMetricDelta("lines", beforeMetrics.lineCount, afterMetrics.lineCount),
            formatMetricDelta("imports", beforeMetrics.importCount, afterMetrics.importCount),
          ].filter(Boolean);

          let output = `Created ${displayPath(filePath)} (${String(content.split("\n").length)} lines)`;
          if (deltas.length > 0) output += ` (${deltas.join(", ")})`;
          output = await appendAutoFormatResult(filePath, content, output, args.tabId);
          output = await appendPostEditDiagnostics(diagsPromise, filePath, output);
          return { success: true, output };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            success: false,
            output: `Failed to create ${displayPath(filePath)}: ${msg}`,
            error: msg,
          };
        }
      }

      try {
        await statAsync(filePath);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        const msg =
          code === "EACCES" || code === "EPERM"
            ? `Permission denied: ${filePath}`
            : `File not found: ${filePath}. Use ast_edit with action="create_file" and newCode=<content> to create it.`;
        return { success: false, output: msg, error: msg };
      }

      // CAS: snapshot disk content before ts-morph touches anything
      const contentOnDisk = await readFile(filePath, "utf-8");

      const cwd = process.cwd();
      const backend = getBackend(cwd);

      // Delegate entirely to ts-morph surgical engine
      const result = await backend.surgicalEdit(filePath, ops);

      if (!result.ok) {
        return {
          success: false,
          output: result.error,
          error: "surgical edit failed",
        };
      }

      const { before, after: updated, details } = result;

      // CAS: verify ts-morph's view matches disk (stale project cache detection)
      if (contentOnDisk !== before) {
        const msg = "File content diverged (ts-morph cache stale). Re-read and retry.";
        return { success: false, output: msg, error: "stale cache" };
      }
      // CAS: verify no concurrent modification since our snapshot
      const currentOnDisk = await readFile(filePath, "utf-8");
      if (currentOnDisk !== contentOnDisk) {
        const msg = "File was modified concurrently since last read. Re-read and retry.";
        return { success: false, output: msg, error: "concurrent modification" };
      }

      // Write with full undo + diagnostics pipeline
      const beforeMetrics = analyzeFile(before);
      const afterMetrics = analyzeFile(updated);
      const diagsPromise = startPreEditDiagnostics(filePath);

      pushEdit(filePath, before, updated, args.tabId);
      await writeFile(filePath, updated, "utf-8");
      markToolWrite(filePath);
      emitFileEdited(filePath, updated);

      reloadBuffer(filePath, 1).catch(() => {});

      const deltas = [
        formatMetricDelta("lines", beforeMetrics.lineCount, afterMetrics.lineCount),
        formatMetricDelta("imports", beforeMetrics.importCount, afterMetrics.importCount),
      ].filter(Boolean);

      let output: string;
      if (details.length === 1) {
        output = details[0] ?? "";
      } else {
        output = `${String(details.length)} ops:\n${details.map((d: string) => `  • ${d}`).join("\n")}`;
      }
      if (deltas.length > 0) output += ` (${deltas.join(", ")})`;

      output = await appendAutoFormatResult(filePath, updated, output, args.tabId);
      output = await appendPostEditDiagnostics(diagsPromise, filePath, output);
      output = await appendCloneHints(filePath, output);

      // Consume any pending nudge (no-op after first fire per session)
      await consumeAstEditNudge(filePath);

      return { success: true, output };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: msg, error: msg };
    }
  },
};
