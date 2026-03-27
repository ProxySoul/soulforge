import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { PrepareStepFunction, StopCondition } from "ai";
import { stepCountIs } from "ai";
import { renderTaskList } from "../tools/task-list.js";
import type { AgentBus } from "./agent-bus.js";
import { emitSubagentStep } from "./subagent-events.js";

type SymbolLookup = (absPath: string) => Array<{ name: string; kind: string; isExported: boolean }>;

/** Global flag — set by /export api command. When true, each step dumps full request/response data. */
let apiExportEnabled = false;
export function setApiExportEnabled(v: boolean): void {
  apiExportEnabled = v;
}
export function isApiExportEnabled(): boolean {
  return apiExportEnabled;
}

export interface PrepareStepOptions {
  bus?: AgentBus;
  agentId?: string;
  parentToolCallId?: string;
  role: import("./agent-bus.js").AgentRole;
  allTools: Record<string, unknown>;
  symbolLookup?: SymbolLookup;
  contextWindow?: number;
  disablePruning?: boolean;
}

// Context-proportional thresholds (fraction of model's context window).
// Agents run until done naturally; these are guardrails as context fills up.
const OUTPUT_NUDGE_PCT = 0.8;
const HARD_STOP_PCT = 0.9;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const MAX_SUBAGENT_CONTEXT = 200_000;

const KEEP_RECENT_MESSAGES = 4;

// Token-budget pruning: protect last N tokens of tool results,
// blank everything older. More forgiving than message-count for subagents.
const PRUNE_PROTECT_TOKENS = 40_000;
const PRUNE_MINIMUM_TOKENS = 20_000;
const PRUNED_PLACEHOLDER = "[Old tool result content cleared]";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Step-count limits — hard caps to prevent runaway loops.
// Bumped +3 from original (25/15) to compensate for the final step being
// forced to toolChoice:"none" (text-only) — agents need room to finish work
// before the text-only summary requirement kicks in.
const EXPLORE_MAX_STEPS = 28;
const CODE_MAX_STEPS = 18;
// Step at which we inject a "wrap up" nudge (before hard stop)
const STEP_NUDGE_EXPLORE = 18;
const STEP_NUDGE_CODE = 10;
// Consecutive read operations before injecting a "stop reading, start editing" hint
const CONSECUTIVE_READ_LIMIT = 3;
// Identical tool call repetitions before injecting a loop-break hint
const REPEAT_CALL_THRESHOLD = 3;
const REPEAT_CALL_WINDOW = 8;

const READ_TOOL_NAMES = new Set(["read_file", "navigate", "soul_find", "list_dir"]);

/**
 * Detect degenerate tool-call loops: same tool + same args repeated across recent steps.
 * Returns the worst offender (highest repeat count) or null.
 */
export function detectRepeatedCalls(
  steps: ReadonlyArray<{
    toolCalls: ReadonlyArray<{ toolName: string; input?: unknown }>;
  }>,
  window = REPEAT_CALL_WINDOW,
  threshold = REPEAT_CALL_THRESHOLD,
): { toolName: string; count: number; signature: string } | null {
  const counts = new Map<string, { toolName: string; count: number }>();
  const start = Math.max(0, steps.length - window);
  for (let i = start; i < steps.length; i++) {
    const calls = steps[i]?.toolCalls;
    if (!calls) continue;
    for (const tc of calls) {
      let argStr: string;
      try {
        argStr = JSON.stringify(tc.input ?? {});
      } catch {
        argStr = "{}";
      }
      const sig = `${tc.toolName}::${argStr}`;
      const entry = counts.get(sig);
      if (entry) entry.count++;
      else counts.set(sig, { toolName: tc.toolName, count: 1 });
    }
  }
  let worst: { toolName: string; count: number; signature: string } | null = null;
  for (const [sig, entry] of counts) {
    if (entry.count >= threshold && (!worst || entry.count > worst.count)) {
      worst = { toolName: entry.toolName, count: entry.count, signature: sig };
    }
  }
  return worst;
}

const SUMMARIZABLE_TOOLS = new Set([
  "read_file",
  "grep",
  "glob",
  "analyze",
  "web_search",
  "fetch_page",
  "shell",
  "dispatch",
  "list_dir",
  "soul_grep",
  "soul_analyze",
  "soul_impact",
  "memory",
  "skills",
  "plan",
  "update_plan_step",
  "ask_user",
  "git",
]);

const EDIT_TOOLS = new Set(["edit_file", "multi_edit", "write_file", "create_file"]);

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

interface SummaryContext {
  symbolHint?: string;
  args?: Record<string, unknown>;
}

function buildSummary(toolName: string, text: string, ctx?: SummaryContext): string | null {
  const lineCount = text.split("\n").length;
  const charCount = text.length;

  if (charCount <= 200) return null;

  const args = ctx?.args;
  const tag = "←";

  if (toolName === "read_file") {
    const parts = [`${tag} ${String(lineCount)} lines`];
    if (ctx?.symbolHint) parts.push(ctx.symbolHint);
    return parts.join(" — ");
  }
  if (toolName === "grep" || toolName === "soul_grep") {
    const matchCount = (text.match(/\n/g) || []).length;
    const pattern = typeof args?.pattern === "string" ? ` for "${args.pattern.slice(0, 40)}"` : "";
    return `${tag} ${String(matchCount)} matches${pattern}`;
  }
  if (toolName === "glob") {
    const fileCount = text.trim().split("\n").length;
    const pattern = typeof args?.pattern === "string" ? ` for ${args.pattern}` : "";
    return `${tag} ${String(fileCount)} files${pattern}`;
  }
  if (toolName === "shell") {
    const cmd = typeof args?.command === "string" ? args.command.slice(0, 60) : "";
    const lastLine = text.trim().split("\n").pop() ?? "";
    const exitHint = /exit code[: ]+(\d+)/i.test(lastLine)
      ? ` — ${lastLine.slice(0, 40)}`
      : text.includes("error") || text.includes("Error")
        ? " — had errors"
        : " — ok";
    return `${tag} \`${cmd}\` → ${String(lineCount)} lines${exitHint}`;
  }
  if (toolName === "dispatch") {
    const parts: string[] = [`${tag} dispatch completed`];
    const headingMatch = text.match(/^## (.+)/m);
    if (headingMatch?.[1]) parts.push(headingMatch[1].trim());
    const agentMatch = text.match(/\*\*(\d+\/\d+)\*\* agents/);
    if (agentMatch) parts.push(`${agentMatch[1]} agents`);
    const filesMatch = text.match(/### Files Edited\n([\s\S]*?)(?:\n###|$)/);
    if (filesMatch?.[1]) parts.push(`edited: ${filesMatch[1].trim()}`);
    const agentSections = text.match(/### [✓✗] Agent: .+/g);
    if (agentSections) {
      const agents = agentSections.slice(0, 5).map((s) => s.replace(/^### [✓✗] Agent: /, ""));
      parts.push(`agents: ${agents.join(", ")}`);
    }
    const verifyMatch = text.match(/VERDICT: (PASS|FAIL|PARTIAL)(?:\s*—\s*(.+))?/);
    if (verifyMatch)
      parts.push(
        `verification: ${verifyMatch[1]}${verifyMatch[2] ? ` — ${verifyMatch[2].slice(0, 60)}` : ""}`,
      );
    return parts.join(" — ");
  }
  if (toolName === "list_dir") {
    const entryMatch = text.match(/(\d+) entries/);
    return `${tag} ${entryMatch ? entryMatch[1] : String(lineCount)} entries`;
  }
  // soul_find: NOT summarized — results are small (file paths) and compacting them
  // causes the agent to think it hasn't found anything, triggering loops
  if (toolName === "soul_analyze" || toolName === "soul_impact") {
    const action = typeof args?.action === "string" ? `${args.action}: ` : "";
    const firstLine = text.split("\n")[0] ?? "";
    return `${tag} ${action}${firstLine.slice(0, 120)}`;
  }
  if (toolName === "memory") {
    const count = text.trim().split("\n").length;
    return `${tag} ${String(count)} memories`;
  }
  if (toolName === "plan") {
    const titleMatch = text.match(/^# (.+)/m);
    const stepCount = (text.match(/^### /gm) || []).length;
    const title = titleMatch ? titleMatch[1]?.slice(0, 60) : "plan";
    return `${tag} plan "${title}" — ${String(stepCount)} steps`;
  }
  if (toolName === "update_plan_step") {
    const firstLine = text.split("\n")[0] ?? "";
    return `${tag} ${firstLine.slice(0, 80)}`;
  }
  if (toolName === "ask_user") {
    const firstLine = text.split("\n")[0] ?? "";
    return `${tag} user: ${firstLine.slice(0, 80)}`;
  }
  if (toolName === "git") {
    const firstLine = text.split("\n")[0] ?? "";
    return `${tag} ${firstLine.slice(0, 100)}`;
  }
  if (toolName === "skills") {
    const firstLine = text.split("\n")[0] ?? "";
    return `${tag} ${firstLine.slice(0, 100)}`;
  }
  return `${tag} ${String(lineCount)} lines, ${String(charCount)} chars`;
}

function buildToolCallPathMap(messages: ModelMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== "assistant" || typeof msg.content === "string") continue;
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type !== "tool-call") continue;
      if (part.toolName !== "read_file") continue;
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


/** Compact old tool results beyond KEEP_RECENT_MESSAGES into one-line summaries.
 *  Keeps edit tool results intact (needed for conversation coherence). */
function compactOldToolResults(
  messages: ModelMessage[],
  symbolLookup?: SymbolLookup,
  pathMap?: Map<string, string>,
): ModelMessage[] {
  if (messages.length <= KEEP_RECENT_MESSAGES) return messages;

  const cutoff = messages.length - KEEP_RECENT_MESSAGES;
  const resolvedPathMap = pathMap ?? (symbolLookup ? buildToolCallPathMap(messages) : undefined);

  const argsMap = new Map<string, Record<string, unknown>>();
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        (part as { type: string }).type === "tool-call" &&
        "toolCallId" in part &&
        "input" in part
      ) {
        const tc = part as { toolCallId: string; input: unknown };
        if (typeof tc.input === "object" && tc.input !== null) {
          argsMap.set(tc.toolCallId, tc.input as Record<string, unknown>);
        }
      }
    }
  }

  const result: ModelMessage[] = [];
  for (const [idx, msg] of messages.entries()) {
    if (idx >= cutoff) {
      result.push(msg);
      continue;
    }
    if (msg.role !== "tool" || typeof msg.content === "string") {
      result.push(msg);
      continue;
    }
    if (!Array.isArray(msg.content)) {
      result.push(msg);
      continue;
    }

    let changed = false;
    const newContent = [];
    for (const part of msg.content) {
      if (
        part.type !== "tool-result" ||
        EDIT_TOOLS.has(part.toolName) ||
        !SUMMARIZABLE_TOOLS.has(part.toolName)
      ) {
        newContent.push(part);
        continue;
      }
      const text = extractText(part.output);

      let symbolHint: string | undefined;
      if (symbolLookup && resolvedPathMap && part.toolName === "read_file") {
        const absPath = resolvedPathMap.get(part.toolCallId);
        if (absPath) {
          try {
            symbolHint = formatSymbolHint(symbolLookup(absPath));
          } catch {}
        }
      }

      const summary = buildSummary(part.toolName, text, {
        symbolHint,
        args: argsMap.get(part.toolCallId),
      });
      if (!summary) {
        newContent.push(part);
        continue;
      }
      changed = true;
      newContent.push({ ...part, output: { type: "text" as const, value: summary } });
    }

    result.push(changed ? { ...msg, content: newContent } : msg);
  }
  return result as ModelMessage[];
}

/** Token-budget pruning: walk backward through tool results, protect last
 *  PRUNE_PROTECT_TOKENS worth of content, blank everything older.
 *  Less aggressive than message-count pruning — suitable for subagents. */
function pruneByTokenBudget(messages: ModelMessage[]): ModelMessage[] {
  // Walk backward, accumulate tool result token estimates
  type PruneTarget = { msgIdx: number; partIdx: number; tokens: number };
  const targets: PruneTarget[] = [];
  let totalTokens = 0;

  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const msg = messages[mi];
    if (!msg || msg.role !== "tool" || !Array.isArray(msg.content)) continue;
    for (let pi = msg.content.length - 1; pi >= 0; pi--) {
      const part = msg.content[pi] as
        | { type: string; toolName: string; output: unknown }
        | undefined;
      if (!part || part.type !== "tool-result") continue;
      if (EDIT_TOOLS.has(part.toolName)) continue;
      const text = extractText(part.output);
      const tokens = estimateTokens(text);
      if (tokens <= 50) continue;
      totalTokens += tokens;
      targets.push({ msgIdx: mi, partIdx: pi, tokens });
    }
  }

  // Only prune if we'd free enough tokens
  const excess = totalTokens - PRUNE_PROTECT_TOKENS;
  if (excess < PRUNE_MINIMUM_TOKENS) return messages;

  // Mark oldest targets for pruning (they're in reverse order, so the end of the array is oldest)
  let freed = 0;
  const pruneSet = new Set<string>();
  for (let i = targets.length - 1; i >= 0 && freed < excess; i--) {
    const t = targets[i];
    if (!t) continue;
    pruneSet.add(`${String(t.msgIdx)}:${String(t.partIdx)}`);
    freed += t.tokens;
  }

  if (pruneSet.size === 0) return messages;

  return messages.map((msg, mi) => {
    if (msg.role !== "tool" || !Array.isArray(msg.content)) return msg;
    let changed = false;
    const newContent = msg.content.map((part, pi) => {
      if (pruneSet.has(`${String(mi)}:${String(pi)}`)) {
        changed = true;
        return { ...part, output: { type: "text" as const, value: PRUNED_PLACEHOLDER } };
      }
      return part;
    });
    return changed ? { ...msg, content: newContent } : msg;
  }) as ModelMessage[];
}

interface PrepareStepResult {
  // biome-ignore lint/suspicious/noExplicitAny: TOOLS generic is invariant — tool-agnostic functions use <any> (same as SDK's stepCountIs/hasToolCall)
  prepareStep: PrepareStepFunction<any>;
  // biome-ignore lint/suspicious/noExplicitAny: TOOLS generic is invariant
  stopConditions: StopCondition<any>[];
}

export function buildPrepareStep({
  bus,
  agentId,
  parentToolCallId,
  role,
  allTools: _allTools,
  symbolLookup,
  contextWindow: ctxWindow,
  disablePruning,
}: PrepareStepOptions): PrepareStepResult {
  const cw = Math.min(ctxWindow ?? DEFAULT_CONTEXT_WINDOW, MAX_SUBAGENT_CONTEXT);
  const nudgeThreshold = Math.floor(cw * OUTPUT_NUDGE_PCT);
  const hardStop = Math.floor(cw * HARD_STOP_PCT);
  let nudgeFired = false;
  const isExplore = role === "explore" || role === "investigate";
  const stepNudgeAt = isExplore ? STEP_NUDGE_EXPLORE : STEP_NUDGE_CODE;
  const maxSteps = isExplore ? EXPLORE_MAX_STEPS : CODE_MAX_STEPS;

  // biome-ignore lint/suspicious/noExplicitAny: TOOLS generic is invariant — tool-agnostic functions use <any> (same as SDK's stepCountIs/hasToolCall)
  const prepareStep: PrepareStepFunction<any> = ({ stepNumber, steps, messages }) => {
    const result: {
      toolChoice?: "required" | "auto" | "none";
      activeTools?: string[];
      system?: string;
      messages?: ModelMessage[];
    } = {};

    // Sanitize non-dict tool-call inputs to prevent Anthropic API rejections
    let sanitizedMessages: ModelMessage[] | undefined;
    for (let mi = 0; mi < messages.length; mi++) {
      const msg = messages[mi];
      if (!msg) continue;
      if (msg.role !== "assistant" || typeof msg.content === "string") continue;
      if (!Array.isArray(msg.content)) continue;
      let clonedContent: typeof msg.content | undefined;
      for (let i = 0; i < msg.content.length; i++) {
        const part = msg.content[i] as (typeof msg.content)[number];
        if (part.type !== "tool-call") continue;
        const input = (part as { input: unknown }).input;
        if (typeof input === "object" && input !== null && !Array.isArray(input)) continue;
        if (!clonedContent) clonedContent = [...msg.content];
        (clonedContent as unknown[])[i] = { ...part, input: {} };
      }
      if (clonedContent) {
        if (!sanitizedMessages) sanitizedMessages = [...messages];
        sanitizedMessages[mi] = { ...msg, content: clonedContent } as ModelMessage;
      }
    }
    if (sanitizedMessages) result.messages = sanitizedMessages;

    if (stepNumber === 0) {
      result.toolChoice = "required";
    }

    // Tool result pruning: compact old results into summaries to save tokens.
    // Only runs when pruning is enabled (pruningTarget includes "subagents" or "both").
    // Uses token-budget approach: protect last PRUNE_PROTECT_TOKENS, blank older results.
    if (!disablePruning && stepNumber >= 2) {
      const src = result.messages ?? messages;
      const pruned = pruneByTokenBudget(src);
      if (pruned !== src) {
        const compacted = compactOldToolResults(pruned, symbolLookup);
        result.messages = compacted !== pruned ? compacted : pruned;
      }
    }

    // Use the last step's input tokens as actual context size (not cumulative sum).
    // Each step re-sends the full message history, so inputTokens reflects real context window usage.
    const lastStep = steps.length > 0 ? steps[steps.length - 1] : undefined;

    // API export: dump full request data per step
    // Enable via /export api command or SOULFORGE_DEBUG_API=1 env var
    if (apiExportEnabled || process.env.SOULFORGE_DEBUG_API) {
      const msgs = result.messages ?? messages;
      const prevUsage = lastStep?.usage;

      // Serialize each message content into readable form — no [object Object]
      const serializeContent = (content: unknown): unknown => {
        if (typeof content === "string") return content;
        if (!Array.isArray(content)) return String(content);
        return (content as Record<string, unknown>[]).map((part) => {
          const p = part as Record<string, unknown>;
          if (p.type === "tool-call") {
            return {
              type: "tool-call",
              toolCallId: p.toolCallId,
              toolName: p.toolName,
              input: typeof p.input === "string" ? p.input : JSON.stringify(p.input),
            };
          }
          if (p.type === "tool-result") {
            const output = p.output as Record<string, unknown> | undefined;
            let text: string;
            if (output?.type === "text") text = String(output.value ?? "");
            else if (output?.type === "json") text = JSON.stringify(output.value);
            else text = JSON.stringify(output);
            return {
              type: "tool-result",
              toolCallId: p.toolCallId,
              toolName: p.toolName,
              contentLength: text.length,
              content: text,
            };
          }
          if (p.type === "text") return { type: "text", text: String(p.text ?? "") };
          return p;
        });
      };

      const exportData = {
        step: stepNumber,
        timestamp: new Date().toISOString(),
        messageCount: msgs.length,
        activeTools: result.activeTools ?? "all",
        previousStepUsage: prevUsage
          ? {
              inputTokens: prevUsage.inputTokens,
              outputTokens: prevUsage.outputTokens,
              cacheCreationTokens:
                (prevUsage as Record<string, unknown>).cacheCreationInputTokens ?? 0,
              cacheReadTokens: (prevUsage as Record<string, unknown>).cacheReadInputTokens ?? 0,
              totalTokens:
                (prevUsage.inputTokens ?? 0) +
                (prevUsage.outputTokens ?? 0) +
                (((prevUsage as Record<string, unknown>).cacheCreationInputTokens as number) ?? 0) +
                (((prevUsage as Record<string, unknown>).cacheReadInputTokens as number) ?? 0),
            }
          : null,
        messages: msgs.map((m, i) => {
          const content = serializeContent(m.content);
          const charCount =
            typeof content === "string"
              ? content.length
              : Array.isArray(content)
                ? content.reduce(
                    (sum: number, p: Record<string, unknown>) =>
                      sum +
                      (typeof p.content === "string" ? p.content.length : 0) +
                      (typeof p.text === "string" ? p.text.length : 0) +
                      (typeof p.input === "string" ? p.input.length : 0),
                    0,
                  )
                : 0;
          return {
            index: i,
            role: m.role,
            cacheControl: m.providerOptions?.anthropic ? "ephemeral" : undefined,
            charCount,
            estimatedTokens: Math.ceil(charCount / 4),
            content,
          };
        }),
      };

      const json = JSON.stringify(exportData, null, 2);
      import("node:fs").then(({ mkdirSync, writeFileSync }) => {
        const dir = `${process.cwd()}/.soulforge/api-export`;
        mkdirSync(dir, { recursive: true });
        const file = `${dir}/step-${String(stepNumber).padStart(2, "0")}.json`;
        writeFileSync(file, json, "utf-8");
      });
    }

    const contextSize = lastStep?.usage.inputTokens ?? 0;

    if (bus && agentId) {
      const unseen = bus.drainUnseenFindings(agentId);
      if (unseen) {
        const existing = result.system ?? "";
        result.system = `${existing}\n\n--- Peer findings (new) ---\n${unseen}`.trim();
      }
    }

    // Inject task list so it survives compaction
    const taskBlock = renderTaskList();
    if (taskBlock) {
      result.system = `${result.system ?? ""}\n\n${taskBlock}`.trim();
    }

    // Consecutive read detection: count trailing read-only tool calls
    if (stepNumber >= CONSECUTIVE_READ_LIMIT && !nudgeFired) {
      let consecutiveReads = 0;
      for (let i = steps.length - 1; i >= 0; i--) {
        const step = steps[i];
        const calls = step?.toolCalls;
        if (!calls || calls.length === 0) break;
        const allReads = calls.every((tc: { toolName: string }) =>
          READ_TOOL_NAMES.has(tc.toolName),
        );
        if (allReads) consecutiveReads++;
        else break;
      }
      if (consecutiveReads >= CONSECUTIVE_READ_LIMIT) {
        const existing = result.system ?? "";
        const hint = isExplore
          ? "Act on what you have: write a concise text summary of your findings (files, line numbers, values), or use a search tool (soul_grep, grep) if you need something specific."
          : "You have the file contents. Apply your edits with multi_edit NOW.";
        result.system =
          `${existing}\n\n${String(consecutiveReads)} consecutive reads without action. ${hint}`.trim();
      }
    }

    // Degenerate loop detection: identical tool calls repeated across recent steps
    if (stepNumber >= REPEAT_CALL_THRESHOLD) {
      const repeated = detectRepeatedCalls(steps);
      if (repeated) {
        const existing = result.system ?? "";
        result.system =
          `${existing}\n\n🔁 LOOP DETECTED: ${repeated.toolName} called ${String(repeated.count)} times with identical arguments. Results have not changed. Do NOT call it again. Act on the results you already have or try a different approach.`.trim();
      }
    }

    // Step-count nudge: progressively stronger as agent approaches step limit
    if (stepNumber >= stepNudgeAt) {
      const remaining = maxSteps - stepNumber;
      const existing = result.system ?? "";
      if (remaining <= 1) {
        // LAST STEP — force text-only response. No more tool calls.
        const hint = isExplore
          ? "Write your final text summary NOW. Name files, line numbers, exact values found. No more tool calls."
          : "Apply edits with multi_edit NOW then write a summary of what you changed. Last chance.";
        result.system = `${existing}\n\n🛑 FINAL STEP. ${hint}`.trim();
        result.toolChoice = "none";
        result.activeTools = [];
        const msgs = result.messages ?? messages;
        result.messages = [
          ...msgs,
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const,
                text: `This is your FINAL step. Do not call any tools. Write a concise text summary: what you found or changed, which files, key details.`,
              },
            ],
          },
        ];
      } else if (remaining <= 2) {
        const hint = isExplore
          ? "Write your text summary NOW. Name files, line numbers, exact values. No more tool calls."
          : "Apply edits with multi_edit NOW then write a summary of what you changed. Last chance.";
        result.system = `${existing}\n\n🛑 ${String(remaining)} steps left. ${hint}`.trim();
        if (!isExplore) {
          result.activeTools = ["edit_file", "multi_edit", "done", "report_finding"];
        }
      } else {
        const hint = isExplore
          ? "Write your text summary soon. Name files, line numbers, exact values found."
          : "Apply your edits NOW with multi_edit. No more reading.";
        result.system =
          `${existing}\n\n⚠ Step ${String(stepNumber)}/${String(maxSteps)} — ${String(remaining)} steps left. ${hint}`.trim();
      }
    }

    // Token budget nudge: force text-only response before context overflows.
    if (contextSize > nudgeThreshold) {
      nudgeFired = true;
      if (parentToolCallId) {
        emitSubagentStep({
          parentToolCallId,
          toolName: "_nudge",
          args: "token limit",
          state: "done",
          agentId,
        });
      }
      const msgs = result.messages ?? messages;
      result.messages = [
        ...msgs,
        {
          role: "user" as const,
          content: [
            {
              type: "text" as const,
              text: "Stop calling tools. Write a concise text summary now: what you found or changed, which files, key details.",
            },
          ],
        },
      ];
      result.toolChoice = "none";
      result.activeTools = [];
    }

    return Object.keys(result).length > 0 ? result : undefined;
  };

  // Nudge-aware token stop: uses last step's input tokens (actual context window size).
  // If over budget but nudge hasn't fired yet, allow one more step for graceful output.
  // biome-ignore lint/suspicious/noExplicitAny: TOOLS generic is invariant
  const tokenStop: StopCondition<any> = ({ steps }) => {
    const last = steps.length > 0 ? steps[steps.length - 1] : undefined;
    const ctx = last?.usage.inputTokens ?? 0;
    if (ctx >= hardStop && !nudgeFired) return false;
    return ctx >= hardStop;
  };

  return { prepareStep, stopConditions: [tokenStop, stepCountIs(maxSteps)] };
}

export function buildSymbolLookup(repoMap?: {
  isReady: boolean;
  getCwd(): string;
  getFileSymbolsCached(relPath: string): Array<{ name: string; kind: string; isExported: boolean }>;
}): SymbolLookup | undefined {
  if (!repoMap) return undefined;
  return (absPath: string) => {
    if (!repoMap.isReady) return [];
    const cwd = repoMap.getCwd();
    let rel: string;
    if (absPath.startsWith(`${cwd}/`)) {
      rel = absPath.slice(cwd.length + 1);
    } else if (absPath.startsWith("./")) {
      rel = absPath.slice(2);
    } else {
      rel = absPath;
    }
    return repoMap.getFileSymbolsCached(rel);
  };
}

export { compactOldToolResults, KEEP_RECENT_MESSAGES, pruneByTokenBudget };
