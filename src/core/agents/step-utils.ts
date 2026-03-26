import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { PrepareStepFunction, StopCondition } from "ai";
import { stepCountIs } from "ai";
import { EPHEMERAL_CACHE } from "../llm/provider-options.js";
import { renderTaskList } from "../tools/task-list.js";
import type { AgentBus } from "./agent-bus.js";
import { emitSubagentStep } from "./subagent-events.js";

type SymbolLookup = (absPath: string) => Array<{ name: string; kind: string; isExported: boolean }>;

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

function semanticPrune(messages: ModelMessage[], pathMap?: Map<string, string>): ModelMessage[] {
  // Build a map of file path → index of FIRST edit for that file
  const firstEditIdx = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant" || typeof msg.content === "string") continue;
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type !== "tool-call") continue;
      if (!EDIT_TOOLS.has(part.toolName)) continue;
      const input = part.input as Record<string, unknown>;
      const path = input.path ?? input.file ?? input.filePath;
      if (typeof path === "string" && !firstEditIdx.has(path)) firstEditIdx.set(path, i);
      if (Array.isArray(input.edits)) {
        for (const e of input.edits as Record<string, unknown>[]) {
          const ep = e.file ?? e.path;
          if (typeof ep === "string" && !firstEditIdx.has(ep)) firstEditIdx.set(ep, i);
        }
      }
    }
  }

  if (firstEditIdx.size === 0 && !messages.some((m) => m.role === "tool")) return messages;

  return messages.map((msg, idx) => {
    if (msg.role !== "tool" || typeof msg.content === "string") return msg;
    if (!Array.isArray(msg.content)) return msg;

    let changed = false;
    const newContent = msg.content.map((part) => {
      if (part.type !== "tool-result") return part;

      if (part.toolName === "read_file") {
        const filePath = pathMap?.get(part.toolCallId);
        if (filePath) {
          // 1. Prune read results for files that were LATER edited
          const editIdx = firstEditIdx.get(filePath);
          if (editIdx !== undefined && idx < editIdx) {
            const text = extractText(part.output);
            if (text.length > 200) {
              changed = true;
              return {
                ...part,
                output: {
                  type: "text" as const,
                  value: "← file was edited later in this conversation",
                },
              };
            }
          }
        }
      }

      // 3. Prune canceled plan results immediately
      if (part.toolName === "plan") {
        const text = extractText(part.output);
        if (text.includes("canceled") || text.includes("cancelled")) {
          changed = true;
          const titleMatch = text.match(/plan "([^"]+)"|^# (.+)/m);
          const title = titleMatch?.[1] ?? titleMatch?.[2] ?? "plan";
          return {
            ...part,
            output: { type: "text" as const, value: `← plan "${title}" — canceled` },
          };
        }
      }

      return part;
    });

    return changed ? { ...msg, content: newContent } : msg;
  }) as ModelMessage[];
}

// 3. Edit arg stripping: runs on ALL old messages (step 1+)
function stripOldEditArgs(messages: ModelMessage[], cutoff: number): ModelMessage[] {
  if (cutoff <= 0) return messages;
  return messages.map((msg, idx) => {
    if (idx >= cutoff) return msg;
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) return msg;

    let argsChanged = false;
    const prunedContent = msg.content.map((part) => {
      if (part.type !== "tool-call") return part;
      if (!EDIT_TOOLS.has(part.toolName) && part.toolName !== "editor") return part;
      const input = part.input as Record<string, unknown>;
      if (!input.old_string && !input.new_string && !input.replacement) return part;
      argsChanged = true;
      const slim: Record<string, unknown> = { ...input };
      if (typeof slim.old_string === "string") {
        slim.old_string = `[${String((slim.old_string as string).length)} chars]`;
      }
      if (typeof slim.new_string === "string") {
        slim.new_string = `[${String((slim.new_string as string).length)} chars]`;
      }
      if (typeof slim.replacement === "string") {
        slim.replacement = `[${String((slim.replacement as string).length)} chars]`;
      }
      if (Array.isArray(slim.edits)) {
        slim.edits = (slim.edits as Record<string, unknown>[]).map((e) => {
          const s: Record<string, unknown> = { ...e };
          if (typeof s.oldString === "string")
            s.oldString = `[${String((s.oldString as string).length)} chars]`;
          if (typeof s.newString === "string")
            s.newString = `[${String((s.newString as string).length)} chars]`;
          return s;
        });
      }
      return { ...part, input: slim };
    });
    return argsChanged ? { ...msg, content: prunedContent } : msg;
  }) as ModelMessage[];
}

/** Compact old tool results beyond KEEP_RECENT_MESSAGES into one-line summaries.
 *  Keeps edit tool results intact (needed for conversation coherence).
 *  Runs on every step from step 1+ via buildPrepareStep. */
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
      if (!summary) return part;
      changed = true;
      return { ...part, output: { type: "text" as const, value: summary } };
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
  symbolLookup: _symbolLookup,
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

    // Capture path map BEFORE sanitization wipes malformed inputs
    const pathMap = buildToolCallPathMap(messages);

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

    if (stepNumber > 0 && messages.length >= 2) {
      if (!result.messages) result.messages = [...messages];
      const msgs = result.messages;
      for (const msg of msgs) {
        if (msg.providerOptions?.anthropic) {
          const { anthropic: _, ...rest } = msg.providerOptions;
          msg.providerOptions = Object.keys(rest).length > 0 ? rest : undefined;
        }
      }
      const target = msgs[msgs.length - 2];
      if (target) {
        target.providerOptions = { ...target.providerOptions, ...EPHEMERAL_CACHE };
      }
    }

    // Semantic pruning: stale reads + canceled plans + re-read stubbing
    // Tool result compaction: old tool results → one-line summaries (keeps last KEEP_RECENT_MESSAGES full)
    if (stepNumber >= 1 && !disablePruning) {
      let msgs = result.messages ?? messages;
      msgs = semanticPrune(msgs, pathMap);
      msgs = stripOldEditArgs(msgs, msgs.length - KEEP_RECENT_MESSAGES);
      result.messages = msgs;
    }

    // Debug: dump the exact messages being sent to the API
    // Enable with SOULFORGE_DEBUG_API=1 — writes to .soulforge/tee/
    if (process.env.SOULFORGE_DEBUG_API) {
      const msgs = result.messages ?? messages;
      const dump = msgs
        .map((m, i) => {
          const content =
            typeof m.content === "string"
              ? m.content.slice(0, 500)
              : JSON.stringify(m.content).slice(0, 500);
          return `[${String(i)}] ${m.role} (${String(content.length)} chars): ${content}`;
        })
        .join("\n---\n");
      import("../tools/tee.js").then(({ saveTee }) => {
        saveTee(
          `api-step-${String(stepNumber)}`,
          `Step ${String(stepNumber)} — ${String(msgs.length)} messages\n\n${dump}`,
        );
      });
    }

    // Use the last step's input tokens as actual context size (not cumulative sum).
    // Each step re-sends the full message history, so inputTokens reflects real context window usage.
    const lastStep = steps.length > 0 ? steps[steps.length - 1] : undefined;
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
  getFileSymbols(relPath: string): Array<{ name: string; kind: string; isExported: boolean }>;
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
    return repoMap.getFileSymbols(rel);
  };
}

export { compactOldToolResults, KEEP_RECENT_MESSAGES };
