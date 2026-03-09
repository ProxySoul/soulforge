import type { ModelMessage, ProviderOptions } from "@ai-sdk/provider-utils";
import type { PrepareStepFunction, StopCondition } from "ai";
import type { AgentBus } from "./agent-bus.js";

const ANTHROPIC_CACHE: ProviderOptions = {
  anthropic: { cacheControl: { type: "ephemeral" } },
};

export type SymbolLookup = (
  absPath: string,
) => Array<{ name: string; kind: string; isExported: boolean }>;

interface PrepareStepOptions {
  bus?: AgentBus;
  agentId?: string;
  role: "explore" | "code";
  allTools: Record<string, unknown>;
  symbolLookup?: SymbolLookup;
}

const READ_TOOLS = new Set([
  "read_file",
  "read_code",
  "grep",
  "glob",
  "navigate",
  "analyze",
  "web_search",
  "fetch_page",
  "check_findings",
  "check_peers",
  "check_agent_result",
  "done",
]);

const CONTEXT_TRIM_THRESHOLD_EXPLORE = 50_000;
const CONTEXT_TRIM_THRESHOLD_CODE = 80_000;
const BUDGET_WARNING_THRESHOLD_EXPLORE = 60_000;
const BUDGET_WARNING_THRESHOLD_CODE = 120_000;
const FORCE_DONE_THRESHOLD_EXPLORE = 70_000;
const FORCE_DONE_THRESHOLD_CODE = 135_000;

const KEEP_RECENT_MESSAGES = 6;

const SUMMARIZABLE_TOOLS = new Set([
  "read_file",
  "read_code",
  "grep",
  "glob",
  "navigate",
  "analyze",
  "web_search",
  "fetch_page",
  "shell",
  "dispatch",
]);

const EDIT_TOOLS = new Set(["edit_file", "write_file", "create_file"]);

function extractText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const obj = output as Record<string, unknown>;
    if (typeof obj.value === "string") return obj.value;
    if (typeof obj.output === "string") return obj.output;
    return JSON.stringify(output);
  }
  return String(output);
}

function buildSummary(toolName: string, text: string, symbolHint?: string): string | null {
  const lineCount = text.split("\n").length;
  const charCount = text.length;

  if (charCount <= 200) return null;

  if (toolName === "read_file" || toolName === "read_code") {
    const parts = [`[pruned] ${String(lineCount)} lines`];
    if (symbolHint) {
      parts.push(symbolHint);
    }
    return parts.join(" — ");
  }
  if (toolName === "grep") {
    const matchCount = (text.match(/\n/g) || []).length;
    return `[pruned] ${String(matchCount)} matches`;
  }
  if (toolName === "glob") {
    const fileCount = text.trim().split("\n").length;
    return `[pruned] ${String(fileCount)} files`;
  }
  if (toolName === "shell") {
    return `[pruned] ${String(lineCount)} lines of output`;
  }
  if (toolName === "dispatch") {
    const filesMatch = text.match(/### Files Edited\n([\s\S]*?)(?:\n###|$)/);
    if (filesMatch) return `[pruned] dispatch completed — ${filesMatch[1]?.trim()}`;
    return `[pruned] dispatch completed — ${String(charCount)} chars of output`;
  }
  return `[pruned] ${String(lineCount)} lines, ${String(charCount)} chars`;
}

function buildToolCallPathMap(messages: ModelMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== "assistant" || typeof msg.content === "string") continue;
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type !== "tool-call") continue;
      if (part.toolName !== "read_file" && part.toolName !== "read_code") continue;
      const input = part.input as Record<string, unknown>;
      const path = input.path ?? input.file ?? input.filePath;
      if (typeof path === "string") {
        map.set(part.toolCallId, path);
      }
    }
  }
  return map;
}

function formatSymbolHint(symbols: Array<{ name: string; kind: string }>): string | undefined {
  if (symbols.length === 0) return undefined;
  const names = symbols.map((s) => s.name);
  const display = names.length > 8 ? [...names.slice(0, 8), `+${String(names.length - 8)}`] : names;
  return `exports: ${display.join(", ")}`;
}

function compactOldToolResults(
  messages: ModelMessage[],
  symbolLookup?: SymbolLookup,
  pathMap?: Map<string, string>,
): ModelMessage[] {
  if (messages.length <= KEEP_RECENT_MESSAGES) return messages;

  const cutoff = messages.length - KEEP_RECENT_MESSAGES;
  const resolvedPathMap = pathMap ?? (symbolLookup ? buildToolCallPathMap(messages) : undefined);

  return messages.map((msg, idx) => {
    if (idx >= cutoff) return msg;
    if (msg.role !== "tool" || typeof msg.content === "string") return msg;
    if (!Array.isArray(msg.content)) return msg;

    let changed = false;
    const newContent = msg.content.map((part) => {
      if (part.type !== "tool-result") return part;
      if (EDIT_TOOLS.has(part.toolName)) return part;
      if (!SUMMARIZABLE_TOOLS.has(part.toolName)) return part;
      const text = extractText(part.output);

      let symbolHint: string | undefined;
      if (
        symbolLookup &&
        resolvedPathMap &&
        (part.toolName === "read_file" || part.toolName === "read_code")
      ) {
        const absPath = resolvedPathMap.get(part.toolCallId);
        if (absPath) {
          try {
            symbolHint = formatSymbolHint(symbolLookup(absPath));
          } catch {}
        }
      }

      const summary = buildSummary(part.toolName, text, symbolHint);
      if (!summary) return part;
      changed = true;
      return { ...part, output: { type: "text" as const, value: summary } };
    });

    return changed ? { ...msg, content: newContent } : msg;
  }) as ModelMessage[];
}

export function buildPrepareStep({
  bus,
  agentId,
  role,
  allTools,
  symbolLookup,
  // biome-ignore lint/suspicious/noExplicitAny: TOOLS generic is invariant — tool-agnostic functions use <any> (same as SDK's stepCountIs/hasToolCall)
}: PrepareStepOptions): PrepareStepFunction<any> {
  const allToolNames = Object.keys(allTools);
  const readOnlyNames = allToolNames.filter((n) => READ_TOOLS.has(n));
  const trimThreshold =
    role === "explore" ? CONTEXT_TRIM_THRESHOLD_EXPLORE : CONTEXT_TRIM_THRESHOLD_CODE;

  return ({ stepNumber, steps, messages }) => {
    const result: {
      toolChoice?: "required" | "auto";
      activeTools?: string[];
      system?: string;
      messages?: ModelMessage[];
    } = {};

    // Capture path map BEFORE sanitization wipes malformed inputs
    const pathMap = symbolLookup ? buildToolCallPathMap(messages) : undefined;

    // Sanitize non-dict tool-call inputs to prevent Anthropic API rejections
    for (const msg of messages) {
      if (msg.role !== "assistant" || typeof msg.content === "string") continue;
      if (!Array.isArray(msg.content)) continue;
      for (let i = 0; i < msg.content.length; i++) {
        const part = msg.content[i] as (typeof msg.content)[number];
        if (part.type !== "tool-call") continue;
        const input = (part as { input: unknown }).input;
        if (typeof input === "object" && input !== null && !Array.isArray(input)) continue;
        (msg.content as unknown[])[i] = { ...part, input: {} };
      }
    }

    if (stepNumber === 0) {
      result.toolChoice = "required";
    }

    if (stepNumber > 0 && messages.length >= 2) {
      for (const msg of messages) {
        if (msg.providerOptions?.anthropic) {
          const { anthropic: _, ...rest } = msg.providerOptions;
          msg.providerOptions = Object.keys(rest).length > 0 ? rest : undefined;
        }
      }
      const target = messages[messages.length - 2];
      if (target) {
        target.providerOptions = { ...target.providerOptions, ...ANTHROPIC_CACHE };
      }
    }

    // Compact old tool results before they accumulate
    if (stepNumber >= 3) {
      result.messages = compactOldToolResults(result.messages ?? messages, symbolLookup, pathMap);
    }

    const totalTokens = steps.reduce((sum, s) => {
      return sum + (s.usage.inputTokens ?? 0) + (s.usage.outputTokens ?? 0);
    }, 0);

    if (totalTokens > trimThreshold) {
      if (bus && agentId) {
        result.system = buildBusSummary(bus, agentId, role);
      }
    }

    const forceThreshold =
      role === "explore" ? FORCE_DONE_THRESHOLD_EXPLORE : FORCE_DONE_THRESHOLD_CODE;
    const warnThreshold =
      role === "explore" ? BUDGET_WARNING_THRESHOLD_EXPLORE : BUDGET_WARNING_THRESHOLD_CODE;

    if (totalTokens > forceThreshold) {
      result.activeTools = ["done"];
      result.toolChoice = "required";
      const existing = result.system ?? "";
      result.system =
        `${existing}\nToken budget exhausted. You MUST call done NOW with everything you have. Include all code excerpts and findings gathered so far.`.trim();
    } else if (role === "explore" && totalTokens > warnThreshold) {
      result.activeTools = [...readOnlyNames];
      const existing = result.system ?? "";
      result.system =
        `${existing}\nYou are running low on token budget. Wrap up your research and call done with your findings.`.trim();
    } else if (role === "code" && totalTokens > warnThreshold) {
      const existing = result.system ?? "";
      result.system =
        `${existing}\nYou are running low on token budget. Finish your current edit, verify, and call done.`.trim();
    }

    if (bus && agentId) {
      const unseen = bus.drainUnseenFindings(agentId);
      if (unseen) {
        const existing = result.system ?? "";
        result.system = `${existing}\n\n--- Peer findings (new) ---\n${unseen}`.trim();
      }
    }

    return Object.keys(result).length > 0 ? result : undefined;
  };
}

function buildBusSummary(bus: AgentBus, agentId: string, role: string): string {
  const parts: string[] = [
    "--- Context recovery (old tool results were pruned to save tokens) ---",
  ];

  const myReads = bus.getFilesRead(agentId).get(agentId);
  if (myReads && myReads.length > 0) {
    parts.push(`Files you already read: ${myReads.join(", ")}`);
  }

  if (role === "code") {
    const myEdits = bus.getEditedFiles(agentId);
    if (myEdits.size > 0) {
      parts.push(`Files you edited: ${[...myEdits.keys()].join(", ")}`);
    }
  }

  const peerReads = bus.getFilesRead();
  const peerFiles: string[] = [];
  for (const [peerId, files] of peerReads) {
    if (peerId !== agentId && files.length > 0) {
      peerFiles.push(`${peerId}: ${files.join(", ")}`);
    }
  }
  if (peerFiles.length > 0) {
    parts.push(`Peers' files (cached — your reads will be instant): ${peerFiles.join("; ")}`);
  }

  const toolSummaries = bus.getToolResultSummary();
  if (toolSummaries.length > 0) {
    const display = toolSummaries.slice(0, 20);
    parts.push(`Cached tool results (re-calls will be instant): ${display.join("; ")}`);
  }

  return parts.length > 1 ? parts.join("\n") : "";
}

// biome-ignore lint/suspicious/noExplicitAny: TOOLS generic is invariant — tool-agnostic functions use <any> (same as SDK's stepCountIs/hasToolCall)
export function tokenBudget(maxTokens: number): StopCondition<any> {
  return ({ steps }) => {
    const total = steps.reduce((sum, s) => {
      return sum + (s.usage.inputTokens ?? 0) + (s.usage.outputTokens ?? 0);
    }, 0);
    return total >= maxTokens;
  };
}

export function buildSymbolLookup(repoMap?: {
  isReady: boolean;
  getCwd(): string;
  getFileSymbols(relPath: string): Array<{ name: string; kind: string; isExported: boolean }>;
}): SymbolLookup | undefined {
  if (!repoMap) return undefined;
  return (absPath: string) => {
    if (!repoMap.isReady) return [];
    const cwd = repoMap.getCwd();
    const rel = absPath.startsWith(cwd) ? absPath.slice(cwd.length + 1) : absPath;
    return repoMap.getFileSymbols(rel);
  };
}

export { compactOldToolResults, KEEP_RECENT_MESSAGES };
