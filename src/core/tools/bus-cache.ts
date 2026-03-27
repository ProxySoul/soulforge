import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type AgentBus, normalizePath } from "../agents/agent-bus.js";
import type { IntelligenceClient } from "../workers/intelligence-client.js";

interface WrappableTool {
  description?: string;
  inputSchema?: unknown;
  execute?: (args: never, opts: never) => unknown;
}

export function wrapWithBusCache(
  tools: Record<string, WrappableTool>,
  bus: AgentBus,
  agentId: string,
  repoMap?: IntelligenceClient,
): Record<string, WrappableTool> {
  const wrapped = { ...tools };

  const CACHE_HIT_LINES_THRESHOLD = 80;

  async function tagCacheHit(result: unknown, path: string): Promise<unknown> {
    const text =
      typeof result === "string"
        ? result
        : String((result as Record<string, unknown>)?.output ?? "");
    const lineCount = text.split("\n").length;
    if (lineCount < CACHE_HIT_LINES_THRESHOLD) return result;

    let symbols: Array<{ name: string; kind: string; line: number }> = [];
    if (repoMap) {
      try {
        symbols = (await repoMap.getFileSymbolRanges(path)).map((s) => ({
          name: s.name,
          kind: s.kind,
          line: s.line,
        }));
      } catch {}
    }

    if (symbols.length === 0) {
      const tag = "[Cached]";
      if (typeof result === "string") return `${tag}\n${result}`;
      if (result && typeof result === "object" && "output" in result) {
        return { ...(result as Record<string, unknown>), output: `${tag}\n${text}` };
      }
      return result;
    }

    const top = symbols.slice(0, 12);
    const symbolHint = `Exported symbols: ${top.map((s) => `${s.name} (${s.kind}, line ${String(s.line)})`).join(", ")}${symbols.length > 12 ? `, +${String(symbols.length - 12)} more` : ""}`;

    const stub = [
      `[Cached — ${String(lineCount)} lines, already read by another agent]`,
      symbolHint,
      `Use read_file(target, name, "${path}") for specific symbols, or read_file with startLine/endLine for a range.`,
      `Use check_findings to see what peer agents found in this file.`,
    ].join("\n");

    if (result && typeof result === "object") {
      return { ...(result as Record<string, unknown>), output: stub };
    }
    return { success: true, output: stub };
  }

  function makeCachedExecute(
    origExecute: (args: Record<string, unknown>, opts?: unknown) => Promise<unknown>,
    keyFn: (args: Record<string, unknown>) => string | null,
    onExecute?: (args: Record<string, unknown>, cached: boolean) => void,
  ): WrappableTool["execute"] {
    return (async (args: Record<string, unknown>, opts: unknown) => {
      const key = keyFn(args);
      if (key) {
        const acquired = bus.acquireToolResult(agentId, key);
        if (acquired.hit === true) {
          onExecute?.(args, true);
          return acquired.result;
        }
        if (acquired.hit === "waiting") {
          const waited = await acquired.result;
          if (waited != null) {
            onExecute?.(args, true);
            return waited;
          }
        }
      }
      const result = await origExecute(args, opts);
      if (key) {
        const content =
          typeof result === "string"
            ? result
            : typeof (result as Record<string, unknown>)?.output === "string"
              ? String((result as Record<string, unknown>).output)
              : JSON.stringify(result);
        bus.cacheToolResult(agentId, key, content);
      }
      onExecute?.(args, false);
      return result;
    }) as WrappableTool["execute"];
  }

  const readFile = tools.read_file;
  if (readFile?.execute) {
    const origExecute = readFile.execute as (
      args: { path: string; startLine?: number; endLine?: number },
      opts?: unknown,
    ) => Promise<unknown>;

    wrapped.read_file = {
      ...readFile,
      execute: (async (
        args: { path: string; startLine?: number; endLine?: number },
        opts: unknown,
      ) => {
        const normalized = normalizePath(args.path);

        if (args.startLine != null || args.endLine != null) {
          const result = await origExecute(args, opts);
          bus.recordFileRead(agentId, normalized, {
            tool: "read_file",
            startLine: args.startLine,
            endLine: args.endLine,
            cached: false,
          });
          return result;
        }

        const acquired = bus.acquireFileRead(agentId, normalized);

        if (acquired.cached === true) {
          const cached = acquired.content ?? (await origExecute(args, opts));
          bus.recordFileRead(agentId, normalized, { tool: "read_file", cached: true });
          return tagCacheHit(cached, normalized);
        }

        if (acquired.cached === "waiting") {
          const content = await acquired.content;
          if (content != null) {
            bus.recordFileRead(agentId, normalized, { tool: "read_file", cached: true });
            return tagCacheHit(content, normalized);
          }
          const reAcquired = bus.acquireFileRead(agentId, normalized);
          if (reAcquired.cached === true && reAcquired.content != null) {
            bus.recordFileRead(agentId, normalized, { tool: "read_file", cached: true });
            return tagCacheHit(reAcquired.content, normalized);
          }
          const fallbackGen = reAcquired.cached === false ? reAcquired.gen : -1;
          const result = await origExecute(args, opts);
          const isOutline =
            result &&
            typeof result === "object" &&
            (result as Record<string, unknown>).outlineOnly === true;
          if (!isOutline && fallbackGen >= 0) {
            const rawText =
              typeof result === "string"
                ? result
                : typeof (result as Record<string, unknown>)?.output === "string"
                  ? String((result as Record<string, unknown>).output)
                  : JSON.stringify(result);
            bus.releaseFileRead(normalized, rawText, fallbackGen);
          } else if (isOutline && fallbackGen >= 0) {
            bus.failFileRead(normalized, fallbackGen);
          }
          if (!isOutline) {
            bus.recordFileRead(agentId, normalized, { tool: "read_file", cached: false });
          }
          return result;
        }

        const { gen } = acquired;
        try {
          const result = await origExecute(args, opts);
          const isOutline =
            result &&
            typeof result === "object" &&
            (result as Record<string, unknown>).outlineOnly === true;
          if (isOutline) {
            bus.failFileRead(normalized, gen);
            return result;
          }
          const rawText =
            typeof result === "string"
              ? result
              : typeof (result as Record<string, unknown>)?.output === "string"
                ? String((result as Record<string, unknown>).output)
                : JSON.stringify(result);
          bus.releaseFileRead(normalized, rawText, gen);
          bus.recordFileRead(agentId, normalized, { tool: "read_file", cached: false });
          return result;
        } catch (error) {
          bus.failFileRead(normalized, gen);
          throw error;
        }
      }) as WrappableTool["execute"],
    };
  }

  const editFile = tools.edit_file;
  if (editFile?.execute) {
    const origEdit = editFile.execute as (
      args: { path: string; oldString: string; newString: string },
      opts?: unknown,
    ) => Promise<unknown>;

    wrapped.edit_file = {
      ...editFile,
      execute: (async (
        args: { path: string; oldString: string; newString: string },
        opts: unknown,
      ) => {
        const normalized = normalizePath(args.path);
        const { release, owner } = await bus.acquireEditLock(agentId, normalized);
        try {
          const result = await origEdit(args, opts);
          const isOk =
            result &&
            typeof result === "object" &&
            (result as Record<string, unknown>).success === true;
          if (isOk) {
            try {
              const fresh = readFileSync(resolve(normalized), "utf-8");
              bus.updateFile(normalized, fresh, agentId);
            } catch {
              bus.invalidateFile(normalized);
            }
          } else {
            bus.invalidateFile(normalized);
          }
          bus.recordFileEdit(agentId, normalized);

          if (owner && owner !== agentId && isOk) {
            const text = typeof result === "string" ? result : JSON.stringify(result);
            return `⚠ Note: ${owner} also edited ${normalized}. Your edit succeeded (different region). Verify with read_file if needed.\n\n${text}`;
          }
          if (owner && owner !== agentId && !isOk) {
            const text = typeof result === "string" ? result : JSON.stringify(result);
            return `⚠ Edit failed — ${owner} modified ${normalized} before you. Re-read the file to see current content and adapt your edit.\n\n${text}`;
          }
          return result;
        } finally {
          release();
        }
      }) as WrappableTool["execute"],
    };
  }

  const multiEdit = tools.multi_edit;
  if (multiEdit?.execute) {
    const origMultiEdit = multiEdit.execute as (
      args: {
        path: string;
        edits: Array<{ oldString: string; newString: string; lineStart?: number }>;
      },
      opts?: unknown,
    ) => Promise<unknown>;

    wrapped.multi_edit = {
      ...multiEdit,
      execute: (async (
        args: {
          path: string;
          edits: Array<{ oldString: string; newString: string; lineStart?: number }>;
        },
        opts: unknown,
      ) => {
        const normalized = normalizePath(args.path);
        const { release, owner } = await bus.acquireEditLock(agentId, normalized);
        try {
          const result = await origMultiEdit(args, opts);
          const isOk =
            result &&
            typeof result === "object" &&
            (result as Record<string, unknown>).success === true;
          if (isOk) {
            try {
              const fresh = readFileSync(resolve(normalized), "utf-8");
              bus.updateFile(normalized, fresh, agentId);
            } catch {
              bus.invalidateFile(normalized);
            }
          } else {
            bus.invalidateFile(normalized);
          }
          bus.recordFileEdit(agentId, normalized);

          if (owner && owner !== agentId && isOk) {
            const text = typeof result === "string" ? result : JSON.stringify(result);
            return `⚠ Note: ${owner} also edited ${normalized}. Your multi_edit succeeded (different region). Verify with read_file if needed.\n\n${text}`;
          }
          if (owner && owner !== agentId && !isOk) {
            const text = typeof result === "string" ? result : JSON.stringify(result);
            return `⚠ Multi-edit failed — ${owner} modified ${normalized} before you. Re-read the file to see current content and adapt your edits.\n\n${text}`;
          }
          return result;
        } finally {
          release();
        }
      }) as WrappableTool["execute"],
    };
  }

  const NAVIGATE_CACHEABLE = new Set([
    "definition",
    "references",
    "symbols",
    "imports",
    "exports",
    "workspace_symbols",
    "call_hierarchy",
    "implementation",
    "type_hierarchy",
    "search_symbols",
  ]);
  const ANALYZE_CACHEABLE = new Set(["diagnostics", "outline", "type_info"]);

  const cacheSpecs: Array<{
    name: string;
    keyFn: (args: Record<string, unknown>) => string | null;
    onExecute?: (args: Record<string, unknown>, cached: boolean) => void;
  }> = [
    {
      name: "grep",
      keyFn: (a) =>
        JSON.stringify([
          "grep",
          String(a.pattern ?? ""),
          normalizePath(String(a.path ?? ".")),
          String(a.glob ?? ""),
        ]),
    },
    {
      name: "glob",
      keyFn: (a) =>
        JSON.stringify(["glob", String(a.pattern ?? ""), normalizePath(String(a.path ?? "."))]),
    },
    {
      name: "navigate",
      keyFn: (a) => {
        if (!NAVIGATE_CACHEABLE.has(String(a.action ?? ""))) return null;
        return JSON.stringify([
          "navigate",
          String(a.action),
          normalizePath(String(a.file ?? "")),
          String(a.symbol ?? ""),
        ]);
      },
    },
    {
      name: "analyze",
      keyFn: (a) => {
        const action = String(a.action ?? "");
        if (!ANALYZE_CACHEABLE.has(action) || !a.file) return null;
        return JSON.stringify(["analyze", action, normalizePath(String(a.file))]);
      },
    },
    {
      name: "web_search",
      keyFn: (a) => JSON.stringify(["web_search", String(a.query ?? "")]),
    },
    {
      name: "list_dir",
      keyFn: (a) => JSON.stringify(["list_dir", normalizePath(String(a.path ?? "."))]),
    },
    {
      name: "soul_grep",
      keyFn: (a) =>
        JSON.stringify([
          "soul_grep",
          String(a.pattern ?? ""),
          String(a.path ?? "."),
          String(a.count ?? ""),
          String(a.wordBoundary ?? ""),
        ]),
    },
    {
      name: "soul_find",
      keyFn: (a) => JSON.stringify(["soul_find", String(a.query ?? ""), String(a.type ?? "")]),
    },
    {
      name: "soul_analyze",
      keyFn: (a) =>
        JSON.stringify([
          "soul_analyze",
          String(a.action ?? ""),
          normalizePath(String(a.file ?? "")),
        ]),
    },
    {
      name: "soul_impact",
      keyFn: (a) =>
        JSON.stringify([
          "soul_impact",
          String(a.action ?? ""),
          normalizePath(String(a.file ?? "")),
        ]),
    },
  ];

  for (const spec of cacheSpecs) {
    const t = tools[spec.name];
    if (t?.execute) {
      wrapped[spec.name] = {
        ...t,
        execute: makeCachedExecute(
          t.execute as (args: Record<string, unknown>, opts?: unknown) => Promise<unknown>,
          spec.keyFn,
          spec.onExecute,
        ),
      };
    }
  }

  return wrapped;
}
