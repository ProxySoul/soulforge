import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { logBackgroundError } from "../../stores/errors.js";
import type { AgentFeatures } from "../../types/index.js";
import { getWorkspaceCoordinator } from "../coordination/WorkspaceCoordinator.js";
import type { RepoMap } from "../intelligence/repo-map.js";
import { getModelContextWindow } from "../llm/models.js";
// detectModelFamily removed — subagent pruning is now always disabled
import { getActiveTaskTab } from "../tools/task-list.js";
import { AgentBus, type AgentTask, normalizePath, type SharedCache } from "./agent-bus.js";
import { cleanupDispatchDir, type DispatchOutput, type DoneToolResult } from "./agent-results.js";
import {
  detectTaskTier,
  MAX_CONCURRENT_AGENTS,
  runAgentTask,
  selectModel,
  sleep,
  stripContextManagement,
} from "./agent-runner.js";
import { runDesloppify, runEvaluator, runVerifier } from "./agent-verification.js";
import { createCodeAgent } from "./code.js";
import { createExploreAgent } from "./explore.js";
import { emitAgentStats, emitMultiAgentEvent, emitSubagentStep } from "./subagent-events.js";

export interface SharedCacheRef {
  current: SharedCache | undefined;
  updateFile(path: string, content: string): void;
}

export interface SubagentModels {
  defaultModel: LanguageModel;
  explorationModel?: LanguageModel;
  codingModel?: LanguageModel;
  webSearchModel?: LanguageModel;
  trivialModel?: LanguageModel;
  desloppifyModel?: LanguageModel;
  verifyModel?: LanguageModel;
  providerOptions?: ProviderOptions;
  headers?: Record<string, string>;
  onApproveWebSearch?: (query: string) => Promise<boolean>;
  onApproveFetchPage?: (url: string) => Promise<boolean>;
  readOnly?: boolean;
  repoMap?: RepoMap;
  sharedCacheRef?: SharedCacheRef;
  agentFeatures?: AgentFeatures;
  skills?: Array<{ name: string; content: string }>;
  disablePruning?: boolean;
}

function formatToolArgs(toolCall: { toolName: string; input?: unknown }): string {
  const a = (toolCall.input ?? {}) as Record<string, unknown>;
  if (toolCall.toolName === "read_file" && a.path) return String(a.path);
  if (toolCall.toolName === "grep" && a.pattern) return `/${String(a.pattern)}/`;
  if (toolCall.toolName === "glob" && a.pattern) return String(a.pattern);
  if (toolCall.toolName === "shell" && a.command) {
    const cmd = String(a.command);
    return cmd.length > 50 ? `${cmd.slice(0, 47)}...` : cmd;
  }
  if (toolCall.toolName === "edit_file" && a.path) return String(a.path);
  if (toolCall.toolName === "project" && a.action) {
    const parts = [a.action, a.file].filter(Boolean).map(String);
    return parts.join(" ");
  }
  if (toolCall.toolName === "rename_symbol" && a.symbol) {
    return `${String(a.symbol)} → ${String(a.newName ?? "")}`;
  }
  if (toolCall.toolName === "move_symbol" && a.symbol) {
    return `${String(a.symbol)} → ${String(a.to ?? "")}`;
  }
  return "";
}

export function buildStepCallbacks(parentToolCallId: string, agentId?: string) {
  const acc = { toolUses: 0, stepCount: 0, input: 0, output: 0, cacheRead: 0 };
  // Accumulate steps so they survive NoObjectGeneratedError (AI SDK doesn't attach steps to that error)
  // biome-ignore lint/suspicious/noExplicitAny: step shape varies across SDK versions
  const steps: any[] = [];

  return {
    experimental_onToolCallStart: (event: { toolCall?: { toolName: string; input?: unknown } }) => {
      const tc = event.toolCall;
      if (!tc) return;
      emitSubagentStep({
        parentToolCallId,
        toolName: tc.toolName,
        args: formatToolArgs(tc),
        state: "running",
        agentId,
      });
    },
    experimental_onToolCallFinish: (event: {
      toolCall?: { toolName: string; input?: unknown };
      output?: unknown;
      result?: unknown;
      success?: boolean;
    }) => {
      const tc = event.toolCall;
      if (!tc) return;
      let backend: string | undefined;
      const res = event.output ?? event.result;
      if (res && typeof res === "object") {
        const b = (res as Record<string, unknown>).backend;
        if (typeof b === "string") backend = b;
      }
      emitSubagentStep({
        parentToolCallId,
        toolName: tc.toolName,
        args: formatToolArgs(tc),
        state: event.success ? "done" : "error",
        agentId,
        backend,
      });
    },
    onStepFinish: (step: {
      toolCalls?: unknown[];
      toolResults?: unknown[];
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        inputTokenDetails?: { cacheReadTokens?: number };
      };
    }) => {
      steps.push(step);
      acc.stepCount++;
      acc.toolUses += step.toolCalls?.length ?? 0;
      acc.input += step.usage?.inputTokens ?? 0;
      acc.output += step.usage?.outputTokens ?? 0;
      acc.cacheRead += step.usage?.inputTokenDetails?.cacheReadTokens ?? 0;
      if (agentId) {
        emitAgentStats({
          parentToolCallId,
          agentId,
          toolUses: acc.toolUses,
          stepCount: acc.stepCount,
          tokenUsage: { input: acc.input, output: acc.output, total: acc.input + acc.output },
          cacheHits: acc.cacheRead,
        });
      }
    },
    _acc: acc,
    _steps: steps,
  };
}

export function autoPostCompletionSummary(bus: AgentBus, task: AgentTask): void {
  const readMap = bus.getFilesRead(task.agentId);
  const readFiles = readMap.get(task.agentId) ?? [];
  const editedMap = bus.getEditedFiles(task.agentId);
  const editedFiles = [...editedMap.keys()];

  if (readFiles.length === 0 && editedFiles.length === 0) return;

  const parts: string[] = [];
  if (readFiles.length > 0) parts.push(`Read: ${readFiles.join(", ")}`);
  if (editedFiles.length > 0) parts.push(`Edited: ${editedFiles.join(", ")}`);

  bus.postFinding({
    agentId: task.agentId,
    label: `${task.agentId} completed — ${String(readFiles.length)} files read, ${String(editedFiles.length)} edited`,
    content: parts.join("\n"),
    timestamp: Date.now(),
  });
}

export function createAgent(
  task: AgentTask,
  models: SubagentModels,
  bus: AgentBus,
  parentToolCallId?: string,
  // biome-ignore lint/suspicious/noExplicitAny: explore/code agents have different tool generics
): { agent: any; modelId: string; tier: string } {
  const useExplore =
    task.role === "explore" || task.role === "investigate" || models.readOnly === true;
  const { model } = selectModel(task, models);
  const tier = detectTaskTier(task);
  const subagentProviderOptions = stripContextManagement(models.providerOptions);
  const modelId =
    typeof model === "object" && "modelId" in model ? String(model.modelId) : "unknown";
  const contextWindow = getModelContextWindow(modelId);
  const opts = {
    bus,
    agentId: task.agentId,
    parentToolCallId,
    providerOptions: subagentProviderOptions,
    headers: models.headers,
    webSearchModel: models.webSearchModel,
    onApproveWebSearch: models.onApproveWebSearch,
    onApproveFetchPage: models.onApproveFetchPage,
    repoMap: models.repoMap,
    contextWindow,
    disablePruning: true, // Subagents have 15-step max — pruning causes re-reads, context never gets large enough to matter
    role: task.role === "investigate" ? ("investigate" as const) : ("explore" as const),
  };
  const agent = useExplore ? createExploreAgent(model, opts) : createCodeAgent(model, opts);
  return { agent, modelId, tier };
}

const SKILL_TOKEN_RE = /[a-z0-9]+/gi;
const SKILL_MATCH_THRESHOLD = 2;
const SKILL_NAME_WEIGHT = 3;
const SKILL_PREVIEW_CHARS = 200;
const SKILL_MAX_INJECT_CHARS = 2000;

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const m of text.matchAll(SKILL_TOKEN_RE)) {
    const t = m[0].toLowerCase();
    if (t.length >= 2) tokens.add(t);
  }
  return tokens;
}

function matchSkillsToTask(
  skills: Array<{ name: string; content: string }>,
  taskDescription: string,
): Array<{ name: string; content: string }> {
  if (skills.length === 0) return [];
  const taskTokens = tokenize(taskDescription);
  if (taskTokens.size === 0) return [];

  const scored: Array<{ name: string; content: string; score: number }> = [];
  for (const skill of skills) {
    const nameTokens = tokenize(skill.name);
    const contentTokens = tokenize(skill.content.slice(0, SKILL_PREVIEW_CHARS));
    let score = 0;
    for (const t of taskTokens) {
      if (nameTokens.has(t)) score += SKILL_NAME_WEIGHT;
      if (contentTokens.has(t)) score += 1;
    }
    if (score >= SKILL_MATCH_THRESHOLD) {
      scored.push({ name: skill.name, content: skill.content, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map(({ name, content }) => ({ name, content }));
}

export function buildSubagentTools(models: SubagentModels) {
  const cacheRef: SharedCacheRef = models.sharedCacheRef ?? {
    current: undefined,
    updateFile() {},
  };

  let turnDispatchCount = 0;
  const turnDispatchSummaries: string[] = [];

  return {
    dispatch: tool({
      description:
        "Dispatch parallel subagents for multi-file tasks. " +
        "Use when: 7+ files, or 2+ independent tasks that can run in parallel. " +
        "Do NOT use for ≤6 files — read/edit directly instead. " +
        "Each task MUST name specific files and symbols. Split by file ownership. " +
        "Roles: explore (read-only), investigate (broad analysis), code (edits).",
      inputSchema: z.object({
        tasks: z
          .array(
            z.object({
              task: z
                .string()
                .describe(
                  "What the agent should do — extraction instructions referencing the target files and symbols",
                ),
              targetFiles: z
                .array(z.string())
                .describe(
                  "Exact file paths from the Soul Map that this task targets. Web search tasks use ['web'].",
                ),
              role: z
                .enum(["explore", "code", "investigate"])
                .optional()
                .describe(
                  "Agent role (default: explore). " +
                    "explore = targeted extraction, investigate = broad cross-cutting analysis (scans with soul_grep/soul_analyze/grep), code = edits",
                ),
              returnFormat: z
                .enum(["summary", "code", "files", "full", "verdict"])
                .describe(
                  "What you need back from this agent. " +
                    "summary: concise findings + reasoning, no code blocks. " +
                    "code: pasteable code snippets with file paths and line numbers. " +
                    "files: file paths only with one-line descriptions of what was found/changed. " +
                    "full: complete analysis with code, reasoning, and all details. " +
                    "verdict: yes/no answer with brief justification (for validation tasks).",
                ),
              id: z.string().optional().describe("Unique ID (auto-generated if omitted)"),
              taskId: z
                .number()
                .optional()
                .describe("Link to a task_list task ID — auto-marks done/failed on completion"),
              dependsOn: z
                .array(z.string())
                .optional()
                .describe("IDs of tasks that must complete first"),
            }),
          )
          .min(1)
          .max(8)
          .describe("Agent tasks to dispatch (system max 8, 3 concurrent when possible)"),
        objective: z
          .string()
          .optional()
          .describe("High-level objective (useful for multi-agent coordination)"),
        force: z
          .boolean()
          .optional()
          .describe(
            "Override all dispatch validation (per-turn dispatch limit, file overlap between agents, investigation quality, ≤4 file rejection, web task limit). Only set true AFTER reviewing all previous dispatch results and confirming they lack the specific information you need.",
          ),
        contract: z
          .object({
            filesNeeded: z
              .array(z.string())
              .min(1)
              .describe(
                "ALL file paths you need across all tasks. Must be exact paths from the Soul Map. The system verifies these exist before approving dispatch.",
              ),
            reason: z
              .string()
              .min(10)
              .describe(
                "Why dispatch instead of direct reads? Must justify why this requires parallel agents rather than sequential read_file calls.",
              ),
          })
          .describe(
            "REQUIRED. List every file you need and justify why dispatch is necessary. " +
              "The system verifies files against the Soul Map and rejects hallucinated paths. " +
              "If you need ≤6 files, the system will tell you to read them directly.",
          ),
      }),
      execute: async (rawArgs, { abortSignal, toolCallId }) => {
        const bus = new AgentBus(cacheRef.current);
        const activeTabId = getActiveTaskTab();
        const dispatchTabId = activeTabId ?? "default";
        cleanupDispatchDir(process.cwd(), dispatchTabId, toolCallId);
        if (activeTabId) getWorkspaceCoordinator().agentStarted(activeTabId);
        let editingDone = false;
        let dependentWarning = "";
        try {
          const WEB_MARKER = "web";

          // Contract verification — validate files against Soul Map before proceeding
          if (!rawArgs.contract && !rawArgs.force) {
            return (
              "⛔ dispatch [rejected → no contract]\n" +
              "Provide a contract listing ALL files you need (contract.filesNeeded) and why dispatch is needed (contract.reason). " +
              "The system verifies files against the Soul Map before approving. " +
              "If you need ≤6 files, read them directly instead of dispatching."
            );
          }
          if (rawArgs.contract && !rawArgs.force) {
            const contract = rawArgs.contract;
            const repoMap = models.repoMap;
            const verified: string[] = [];
            const hallucinated: string[] = [];
            const onDiskOnly: string[] = [];
            const symbolCache = new Map<string, ReturnType<RepoMap["getFileSymbolRanges"]>>();
            const cwd = process.cwd();

            for (const file of contract.filesNeeded) {
              const norm = normalizePath(file);
              if (norm === "web") continue;

              // Tier 1: Soul Map (most reliable — has symbols, line ranges)
              if (repoMap) {
                const symbols = repoMap.getFileSymbolRanges(norm);
                symbolCache.set(norm, symbols);
                if (symbols.length > 0) {
                  verified.push(norm);
                  continue;
                }
              }

              // Tier 2: disk existence (for config files, files outside repo map, no repo map)
              const { existsSync } = require("node:fs") as typeof import("node:fs");
              const { resolve: resolvePath, isAbsolute } =
                require("node:path") as typeof import("node:path");
              const abs = isAbsolute(norm) ? norm : resolvePath(cwd, norm);
              if (existsSync(abs)) {
                onDiskOnly.push(norm);
                continue;
              }

              hallucinated.push(norm);
            }

            // Reject hallucinated files
            if (hallucinated.length > 0) {
              return (
                `⛔ dispatch [rejected → hallucinated files]\n` +
                `${String(hallucinated.length)} file(s) in your contract don't exist:\n` +
                hallucinated.map((f) => `  ✗ \`${f}\``).join("\n") +
                `\nCheck the Soul Map for correct paths. Use soul_find if you're unsure of a filename.`
              );
            }

            // Completeness check: all targetFiles across tasks must be in the contract
            const contractSet = new Set([...verified, ...onDiskOnly]);
            const missingFromContract: string[] = [];
            for (const t of rawArgs.tasks) {
              for (const f of t.targetFiles) {
                const norm = normalizePath(f);
                if (norm === "web" || !norm.includes(".")) continue;
                if (!contractSet.has(norm)) missingFromContract.push(norm);
              }
            }
            if (missingFromContract.length > 0) {
              return (
                `⛔ dispatch [rejected → incomplete contract]\n` +
                `Tasks reference files not listed in contract.filesNeeded:\n` +
                [...new Set(missingFromContract)].map((f) => `  ✗ \`${f}\``).join("\n") +
                `\nAdd ALL files to the contract so the system can verify completeness.`
              );
            }

            // Completeness check: for code tasks, collect missing dependents as a warning
            // Skip files not in the repo map index — they were likely just created
            if (repoMap) {
              const codeFiles = rawArgs.tasks
                .filter((t) => t.role === "code")
                .flatMap((t) => t.targetFiles.map(normalizePath));
              if (codeFiles.length > 0) {
                const missingDeps: string[] = [];
                for (const f of codeFiles) {
                  if (!verified.includes(f)) continue;
                  const importers = repoMap.getFileDependents(f);
                  for (const imp of importers.slice(0, 5)) {
                    if (!contractSet.has(imp.path) && !codeFiles.includes(imp.path)) {
                      missingDeps.push(`\`${imp.path}\` imports \`${f}\``);
                    }
                  }
                }
                if (missingDeps.length > 0) {
                  const depList = [...new Set(missingDeps)].slice(0, 5).join("\n  ");
                  dependentWarning = `\n\n⚠️ Files that import your targets (may need updates if exports/signatures changed):\n  ${depList}`;
                }
              }
            }

            // Threshold: ≤6 files → reject with enriched Soul Map info
            const totalFiles = verified.length + onDiskOnly.length;
            const MAX_DIRECT_FILES = 6;
            if (totalFiles > 0 && totalFiles <= MAX_DIRECT_FILES) {
              const fileList: string[] = [];
              for (const f of verified) {
                if (repoMap) {
                  const symbols = symbolCache.get(f) ?? repoMap.getFileSymbolRanges(f);
                  if (symbols.length > 0) {
                    const top = symbols
                      .slice(0, 5)
                      .map((s) => `${s.name} (${s.kind}, L${String(s.line)})`)
                      .join(", ");
                    fileList.push(`  \`${f}\` → ${top}`);
                    continue;
                  }
                }
                fileList.push(`  \`${f}\``);
              }
              for (const f of onDiskOnly) {
                fileList.push(`  \`${f}\` (not in Soul Map — use read_file)`);
              }
              return (
                `⛔ dispatch [rejected → read directly]\n` +
                `You only need ${String(totalFiles)} file(s) — read them directly:\n` +
                fileList.join("\n") +
                `\nUse read_file with target + name for specific symbols or read_file for full files. Dispatch is for 7+ files or parallel edits.`
              );
            }
          }

          if (rawArgs.tasks.length < 2 && !rawArgs.force) {
            return (
              "⛔ dispatch [rejected → single task]\n" +
              "Only 1 task — do it yourself instead of dispatching. " +
              "Dispatch is for 2+ parallel tasks. Read the files directly and make the edits."
            );
          }

          if (models.agentFeatures?.targetFileValidation !== false) {
            for (const t of rawArgs.tasks) {
              const isWebTask =
                t.targetFiles.length === 1 && t.targetFiles[0]?.toLowerCase() === WEB_MARKER;
              if (isWebTask) continue;

              const hasFilePaths = t.targetFiles.some((f) => f.includes("/") || f.includes("."));
              if (!hasFilePaths) {
                return `⛔ dispatch [rejected → invalid targetFiles]\nTask "${t.id ?? "?"}" has no valid file paths in targetFiles. Every non-web task must reference specific files from the Soul Map. Got: [${t.targetFiles.join(", ")}]`;
              }
            }
          }

          let args = rawArgs;
          const MAX_TASKS = 8;
          if (args.tasks.length > MAX_TASKS) {
            const mergeable = args.tasks.filter(
              (t) => (t.role === "explore" || t.role === "investigate") && !t.dependsOn?.length,
            );
            const pinned = args.tasks.filter(
              (t) =>
                (t.role !== "explore" && t.role !== "investigate") ||
                (t.dependsOn?.length ?? 0) > 0,
            );
            if (pinned.length >= MAX_TASKS) {
              return `⛔ dispatch [rejected → too many tasks]\n${String(args.tasks.length)} tasks (max ${String(MAX_TASKS)}). Merge related tasks — split by file ownership, not concept.`;
            }
            const slots = MAX_TASKS - pinned.length;
            mergeable.sort((a, b) => b.targetFiles.length - a.targetFiles.length);
            while (mergeable.length > slots) {
              const removed = mergeable.pop();
              if (!removed || !mergeable[0]) break;
              mergeable[0].task = `${mergeable[0].task}\n\nAlso: ${removed.task}`;
              for (const f of removed.targetFiles) {
                if (!mergeable[0].targetFiles.includes(f)) mergeable[0].targetFiles.push(f);
              }
            }
            args = { ...args, tasks: [...pinned, ...mergeable] };
          }

          if (!args.force && cacheRef.current) {
            const cache = cacheRef.current;
            const allTargetFiles: string[] = [];
            for (const t of args.tasks) {
              if (t.role === "investigate") continue;
              const isWebTask =
                t.targetFiles.length === 1 && t.targetFiles[0]?.toLowerCase() === WEB_MARKER;
              if (!isWebTask) {
                for (const f of t.targetFiles) allTargetFiles.push(normalizePath(f));
              }
            }
            if (allTargetFiles.length > 0) {
              const cached = allTargetFiles.filter((f) => cache.files.has(f));
              const hasCodeTask = args.tasks.some((t) => t.role === "code");
              const missing = allTargetFiles.filter((f) => !cache.files.has(f));

              if (cached.length === allTargetFiles.length && !hasCodeTask) {
                return (
                  `⛔ dispatch [rejected → all files cached]\nALL ${String(cached.length)} target files are already in your context. ` +
                  `You have the data — plan, edit, or respond now. ` +
                  `Set force: true only if you need code agents to EDIT these files.`
                );
              }

              if (cached.length > 0 && cached.length >= allTargetFiles.length * 0.5) {
                const cachedList = cached.map((f) => `\`${f}\``).join(", ");
                const missingHint =
                  missing.length > 0
                    ? ` Files not yet read: ${missing.map((f) => `\`${f}\``).join(", ")}. Use read_file for these ${String(missing.length)} files directly.`
                    : "";
                const actionHint = hasCodeTask
                  ? "Set force: true only if you need agents to EDIT these files."
                  : "Set force: true only if you need agents to do multi-step investigation beyond what's already in context.";
                return `⛔ dispatch [rejected → files already cached]\n${String(cached.length)}/${String(allTargetFiles.length)} target files already in context (${cachedList}).${missingHint} Act on the data you have. ${actionHint}`;
              }
            }
          }

          if (!args.force) {
            // Gate: per-turn dispatch limit
            if (turnDispatchCount > 0) {
              const prev = turnDispatchSummaries
                .map((s, i) => `  ${String(i + 1)}. ${s}`)
                .join("\n");
              return (
                `⛔ dispatch [rejected → repeat dispatch]\nThis is dispatch #${String(turnDispatchCount + 1)} this turn. Previous dispatch(es):\n${prev}\n` +
                `Act on these results before dispatching again. If they lack what you need, use read_file/soul_grep for targeted follow-up. ` +
                `Set force: true only after confirming previous results genuinely lack the specific information you need.`
              );
            }

            // Gate: intra-dispatch file overlap between agents (exact files only, not directories)
            const fileOwners = new Map<string, string[]>();
            for (const t of args.tasks) {
              const isWebTask =
                t.targetFiles.length === 1 && t.targetFiles[0]?.toLowerCase() === WEB_MARKER;
              if (isWebTask) continue;
              const label = t.id ?? t.task.slice(0, 60);
              for (const f of t.targetFiles) {
                const norm = normalizePath(f);
                if (!norm.includes(".")) continue;
                const owners = fileOwners.get(norm);
                if (owners) owners.push(label);
                else fileOwners.set(norm, [label]);
              }
            }
            const overlaps = [...fileOwners.entries()].filter(([, owners]) => owners.length > 1);
            if (overlaps.length > 0) {
              const lines = overlaps
                .slice(0, 5)
                .map(([f, owners]) => `  \`${f}\` — ${owners.join(", ")}`)
                .join("\n");
              return (
                `⛔ dispatch [rejected → file overlap]\n${String(overlaps.length)} file(s) targeted by multiple agents:\n${lines}\n` +
                `Split by file ownership — each file belongs to exactly one agent. ` +
                `Set force: true to proceed anyway.`
              );
            }

            // Gate: cross-tab file overlap — warn when dispatch targets files claimed by other tabs
            const currentTabId = getActiveTaskTab();
            if (currentTabId) {
              const wc = getWorkspaceCoordinator();
              const crossTabConflicts: Array<{ file: string; tabLabel: string }> = [];
              for (const t of args.tasks) {
                if (t.role !== "code") continue;
                for (const f of t.targetFiles) {
                  const norm = normalizePath(f);
                  if (!norm.includes(".")) continue;
                  const conflicts = wc.getConflicts(currentTabId, [norm]);
                  for (const c of conflicts) {
                    crossTabConflicts.push({ file: f, tabLabel: c.ownerTabLabel });
                  }
                }
              }
              if (crossTabConflicts.length > 0) {
                const lines = crossTabConflicts
                  .slice(0, 5)
                  .map((c) => `  \`${c.file}\` — owned by Tab "${c.tabLabel}"`)
                  .join("\n");
                const extra =
                  crossTabConflicts.length > 5
                    ? `\n  (+${String(crossTabConflicts.length - 5)} more)`
                    : "";
                return (
                  `⚠️ dispatch [warning → cross-tab file conflict]\n${String(crossTabConflicts.length)} file(s) are being edited by other tabs:\n${lines}${extra}\n` +
                  `Tell the user about the conflict. Edits will proceed with warnings but may cause merge issues.\n` +
                  `Set force: true to suppress this warning.`
                );
              }
            }

            // Gate: investigation task quality
            const INVESTIGATION_SIGNALS =
              /\?|count|frequency|how many|at least|threshold|metric|pattern|idiom|convention|inconsisten|duplicat|repeated|unused|dead|missing|violat|soul_grep|soul_analyze|soul_impact|grep\b|where\b|which\b|filter|compare|difference|between/i;
            for (const t of args.tasks) {
              if (t.role !== "investigate") continue;
              if (INVESTIGATION_SIGNALS.test(t.task)) continue;
              return (
                `⛔ dispatch [rejected → vague investigation]\nTask "${t.id ?? "?"}" lacks a specific investigation target.\n` +
                `Task: "${t.task.slice(0, 120)}${t.task.length > 120 ? "..." : ""}"\n` +
                `Investigation tasks should specify what to look for: a pattern, a question, a metric, or a comparison. ` +
                `Example: "Use soul_grep count mode to find inline style={{ patterns across all screens, then compare error handling in useSocial vs useAuth."\n` +
                `Set force: true to proceed anyway.`
              );
            }

            // Gate: search-first — reject read-all-files dispatches when grep can answer
            {
              const readOnlyTasks = args.tasks.filter(
                (t) =>
                  (t.role === "explore" || t.role === "investigate") &&
                  !(t.targetFiles.length === 1 && t.targetFiles[0]?.toLowerCase() === WEB_MARKER),
              );
              if (
                !rawArgs.force &&
                readOnlyTasks.length === args.tasks.length &&
                readOnlyTasks.length >= 2
              ) {
                const totalFiles = new Set(
                  readOnlyTasks.flatMap((t) => t.targetFiles.map((f) => normalizePath(f))),
                ).size;
                const tasksSharePrompt =
                  readOnlyTasks.length >= 2 &&
                  readOnlyTasks.every((t) => {
                    const a = readOnlyTasks[0]?.task.slice(0, 80);
                    return t.task.slice(0, 80) === a;
                  });
                if (totalFiles >= 10 && tasksSharePrompt) {
                  return (
                    `⛔ dispatch [rejected → search first]\n` +
                    `${String(readOnlyTasks.length)} agents reading ${String(totalFiles)} files with the same task — use soul_grep first.\n` +
                    `soul_grep with count mode finds patterns across all files in one call (~100 tokens vs ~${String(Math.round(totalFiles * 0.5))}K tokens reading everything).\n` +
                    `Then read only the files with hits. Set force: true if you already searched and need full-file analysis.`
                  );
                }
              }
            }

            const webTasks = args.tasks.filter(
              (t) => t.targetFiles.length === 1 && t.targetFiles[0]?.toLowerCase() === WEB_MARKER,
            );
            if (webTasks.length > 4) {
              return `⛔ dispatch [rejected → too many web tasks]\n${String(webTasks.length)} web search tasks is excessive (max 4). Check the conversation for URLs the user already shared (use fetch_page) and previous search results before searching again. Set force: true only after confirming existing context lacks the answer.`;
            }

            // Gate: reject small dispatches — faster to do directly
            const nonWebTasks = args.tasks.filter(
              (t) =>
                !(t.targetFiles.length === 1 && t.targetFiles[0]?.toLowerCase() === WEB_MARKER),
            );
            if (nonWebTasks.length > 0) {
              const uniqueFiles = new Set<string>();
              for (const t of nonWebTasks) {
                for (const f of t.targetFiles) uniqueFiles.add(normalizePath(f));
              }
              const hasInvestigate = nonWebTasks.some((t) => t.role === "investigate");
              const allExplore = nonWebTasks.every((t) => t.role === "explore");
              const hasCode = nonWebTasks.some((t) => t.role === "code");
              const MAX_EXPLORE_FILES = 3;
              const MAX_CODE_FILES = 3;

              if (
                allExplore &&
                !hasInvestigate &&
                uniqueFiles.size > 0 &&
                uniqueFiles.size <= MAX_EXPLORE_FILES
              ) {
                const fileList = [...uniqueFiles].map((f) => `\`${f}\``).join(", ");
                return (
                  `⛔ dispatch [rejected → too few files]\n${String(uniqueFiles.size)} file${uniqueFiles.size === 1 ? "" : "s"} (${fileList}) — read directly with read_file. ` +
                  `Dispatch is for parallel work across ${String(MAX_EXPLORE_FILES + 1)}+ files or when agents need to EDIT. ` +
                  `Set force: true only if you need agents to do multi-step research beyond simple reads.`
                );
              }

              if (hasCode && uniqueFiles.size <= MAX_CODE_FILES) {
                const fileList = [...uniqueFiles].map((f) => `\`${f}\``).join(", ");
                return (
                  `⛔ dispatch [rejected → too few files]\n${String(uniqueFiles.size)} file${uniqueFiles.size === 1 ? "" : "s"} (${fileList}) — edit directly with edit_file. ` +
                  `Code dispatch is for edits across ${String(MAX_CODE_FILES + 1)}+ files where agents own distinct files. ` +
                  `Set force: true only if the edit requires multi-step work (read → analyze → edit → verify) that justifies an agent.`
                );
              }
            }
          }

          // Auto-split: code tasks with many numbered items targeting 1 file get split
          // into 2 serial sub-tasks to improve reliability (agents choke on 10+ edits)
          const TASK_ITEM_SPLIT_THRESHOLD = 8;
          const countTaskItems = (taskText: string): number => {
            const matches = taskText.match(/^\d+\./gm);
            return matches ? matches.length : 0;
          };

          const expandedTasks: typeof args.tasks = [];
          for (const t of args.tasks) {
            const itemCount = countTaskItems(t.task);
            const isSingleFileCode =
              t.role === "code" &&
              t.targetFiles.length === 1 &&
              t.targetFiles[0]?.toLowerCase() !== WEB_MARKER;

            if (itemCount > TASK_ITEM_SPLIT_THRESHOLD && isSingleFileCode) {
              // Split numbered items into two halves
              const lines = t.task.split("\n");
              const numberedLineIndices: number[] = [];
              for (let li = 0; li < lines.length; li++) {
                if (/^\d+\./.test(lines[li] ?? "")) {
                  numberedLineIndices.push(li);
                }
              }
              const midpoint = Math.ceil(numberedLineIndices.length / 2);
              const splitLineIdx = numberedLineIndices[midpoint] ?? Math.ceil(lines.length / 2);

              // Extract preamble (text before first numbered item)
              const firstItemIdx = numberedLineIndices[0] ?? 0;
              const preamble = lines.slice(0, firstItemIdx).join("\n");

              const firstHalf = lines.slice(0, splitLineIdx).join("\n");
              const secondHalf =
                (preamble ? `${preamble}\n` : "") +
                `Continue from where part 1 left off. Read the file first (it was modified by part 1).\n` +
                lines.slice(splitLineIdx).join("\n");

              const baseId = t.id ?? `agent-${String(expandedTasks.length + 1)}`;
              const firstId = `${baseId}-part1`;
              const secondId = `${baseId}-part2`;

              expandedTasks.push({
                ...t,
                id: firstId,
                task: firstHalf,
                dependsOn: t.dependsOn,
              });
              expandedTasks.push({
                ...t,
                id: secondId,
                task: secondHalf,
                dependsOn: [...(t.dependsOn ?? []), firstId],
              });
            } else {
              expandedTasks.push(t);
            }
          }
          args = { ...args, tasks: expandedTasks };

          const tasks: AgentTask[] = args.tasks.map((t, i) => {
            const isWebTask =
              t.targetFiles.length === 1 && t.targetFiles[0]?.toLowerCase() === WEB_MARKER;
            let fileHint = "";
            if (!isWebTask) {
              const enriched = t.targetFiles.map((f) => {
                if (!models.repoMap) return f;
                const ranges = models.repoMap.getFileSymbolRanges(f);
                if (ranges.length === 0) return f;
                const rangeStr = ranges
                  .map((r) => {
                    const end = r.endLine ? `-${String(r.endLine)}` : "";
                    return `  ${r.name} (${r.kind}, lines ${String(r.line)}${end})`;
                  })
                  .join("\n");
                return `${f}\n${rangeStr}`;
              });
              fileHint = `\nTarget files:\n${enriched.join("\n")}`;
            }
            let skillHint = "";
            if (models.skills && models.skills.length > 0) {
              const matched = matchSkillsToTask(models.skills, t.task);
              for (const s of matched) {
                const truncated =
                  s.content.length > SKILL_MAX_INJECT_CHARS
                    ? `${s.content.slice(0, SKILL_MAX_INJECT_CHARS)}\n[...]`
                    : s.content;
                skillHint += `\n\n--- Relevant skill: ${s.name} ---\n${truncated}`;
              }
            }

            // Inject cross-tab claims so subagents know about other tabs' edits
            let crossTabHint = "";
            if (!isWebTask && t.role === "code") {
              const tabId = getActiveTaskTab();
              if (tabId) {
                const wc = getWorkspaceCoordinator();
                const editors = wc.getActiveEditors();
                const otherEdits: string[] = [];
                for (const [tid] of editors) {
                  if (tid === tabId) continue;
                  const tc = wc.getClaimsForTab(tid);
                  if (tc.size === 0) continue;
                  let label = "Unknown";
                  const paths: string[] = [];
                  for (const [p, c] of tc) {
                    label = c.tabLabel;
                    paths.push(p);
                  }
                  otherEdits.push(
                    `Tab "${label}": ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ` (+${String(paths.length - 5)} more)` : ""}`,
                  );
                }
                if (otherEdits.length > 0) {
                  crossTabHint = `\n\nOther tabs editing files:\n${otherEdits.join("\n")}\nAvoid these files. If you must edit one, your edit will still apply but may conflict.`;
                }
              }
            }

            return {
              agentId: t.id ?? `agent-${String(i + 1)}`,
              role: t.role ?? "explore",
              task: `${t.task}${fileHint}${skillHint}${crossTabHint}`,
              returnFormat: t.returnFormat,
              dependsOn: t.dependsOn,
              taskId: t.taskId,
              tabId: getActiveTaskTab() ?? undefined,
              targetFileCount: isWebTask ? 0 : t.targetFiles.length,
              targetFiles: isWebTask ? [] : t.targetFiles,
            };
          });

          // Auto-serialize code agents that target the same file —
          // concurrent edits to the same file cause old_string mismatch failures.
          // Build a LINEAR chain per file: A→B→C so each agent edits after
          // the previous one finishes (prevents concurrent edit conflicts).
          if (tasks.length > 1) {
            const lastEditor = new Map<string, string>(); // file → most recent agent's id
            for (let i = 0; i < args.tasks.length; i++) {
              const t = args.tasks[i];
              const task = tasks[i];
              if (!t || !task || task.role !== "code") continue;
              for (const f of t.targetFiles) {
                const prev = lastEditor.get(f);
                if (prev && prev !== task.agentId) {
                  if (!task.dependsOn) task.dependsOn = [];
                  if (!task.dependsOn.includes(prev)) {
                    task.dependsOn.push(prev);
                  }
                }
                lastEditor.set(f, task.agentId);
              }
            }
          }

          // Emit warnings for complex tasks that weren't auto-split
          // (e.g. multi-file tasks with many items — can't split those safely)
          for (const t of args.tasks) {
            const itemCount = countTaskItems(t.task);
            if (itemCount > TASK_ITEM_SPLIT_THRESHOLD && t.role === "code") {
              const wasSplit = tasks.some((tk) => tk.agentId.endsWith("-part1"));
              if (!wasSplit) {
                emitMultiAgentEvent({
                  parentToolCallId: toolCallId,
                  type: "agent-warning",
                  agentId: t.id ?? "unknown",
                  role: t.role,
                  task: t.task.slice(0, 200),
                  warning: `High complexity: ${String(itemCount)} numbered items in a single task. Consider breaking this into smaller tasks.`,
                  totalAgents: tasks.length,
                });
              }
            }
          }

          bus.registerTasks(tasks);

          bus.onCacheEvent = (agentId, type, path, sourceAgentId) => {
            emitSubagentStep({
              parentToolCallId: toolCallId,
              toolName: type === "invalidate" ? "edit_file" : "read_file",
              args: path,
              state: type === "wait" ? "running" : "done",
              agentId,
              cacheState: type,
              sourceAgentId,
            });
          };

          bus.onToolCacheEvent = (agentId, toolName, key, type) => {
            let displayArgs = "";
            try {
              const parts = JSON.parse(key) as string[];
              displayArgs = parts.slice(1).join(" ");
            } catch {
              const colonIdx = key.indexOf(":");
              displayArgs = colonIdx >= 0 ? key.slice(colonIdx + 1) : "";
            }
            emitSubagentStep({
              parentToolCallId: toolCallId,
              toolName,
              args: displayArgs,
              state: "done",
              agentId,
              cacheState: type,
            });
          };

          const isSingle = tasks.length === 1;

          if (isSingle) {
            const task = tasks[0] as AgentTask;
            const { doneResult, resultText } = await runAgentTask(
              task,
              models,
              bus,
              toolCallId,
              1,
              abortSignal,
            );
            if (!doneResult && !bus.getResult(task.agentId)?.success) {
              throw new Error(resultText);
            }
            const editedMap = bus.getEditedFiles(task.agentId);

            const desloppifyResult = await runDesloppify(
              bus,
              [task],
              models,
              toolCallId,
              abortSignal,
            );

            const verifyResult = await runVerifier(bus, [task], models, toolCallId, abortSignal);

            const edited = [...editedMap.keys()];
            turnDispatchCount++;
            turnDispatchSummaries.push(
              `${args.objective ?? "Single agent"}: ${edited.length > 0 ? `edited ${edited.join(", ")}` : "read-only"}`,
            );

            const postParts = [desloppifyResult, verifyResult].filter(Boolean);
            const reads = bus.getFileReadRecords(task.agentId);
            const singleOutput =
              postParts.length > 0 ? `${resultText}\n${postParts.join("\n")}` : resultText;
            return {
              reads,
              filesEdited: edited,
              output: singleOutput + dependentWarning,
            } satisfies DispatchOutput;
          }

          emitMultiAgentEvent({
            parentToolCallId: toolCallId,
            type: "dispatch-start",
            totalAgents: tasks.length,
          });

          const taskIds = new Set(tasks.map((t) => t.agentId));
          for (const task of tasks) {
            if (task.dependsOn) {
              for (const dep of task.dependsOn) {
                if (!taskIds.has(dep)) {
                  return `Error: task "${task.agentId}" depends on unknown task "${dep}"`;
                }
              }
            }
          }

          const hasCycle = (() => {
            const visited = new Set<string>();
            const stack = new Set<string>();
            const depMap = new Map(tasks.map((t) => [t.agentId, t.dependsOn ?? []]));
            const dfs = (id: string): boolean => {
              if (stack.has(id)) return true;
              if (visited.has(id)) return false;
              visited.add(id);
              stack.add(id);
              for (const dep of depMap.get(id) ?? []) {
                if (dfs(dep)) return true;
              }
              stack.delete(id);
              return false;
            };
            return tasks.some((t) => dfs(t.agentId));
          })();
          if (hasCycle) return "Error: dependency cycle detected among tasks";

          const combinedAbort = AbortSignal.any(
            [abortSignal, bus.abortSignal].filter(Boolean) as AbortSignal[],
          );

          const STAGGER_MS = 100;
          let inflightCount = 0;
          const inflightWaiters: Array<() => void> = [];

          const acquireConcurrencySlot = async (): Promise<void> => {
            while (inflightCount >= MAX_CONCURRENT_AGENTS) {
              await new Promise<void>((resolve) => inflightWaiters.push(resolve));
            }
            inflightCount++;
          };

          const releaseConcurrencySlot = (): void => {
            inflightCount--;
            const waiter = inflightWaiters.shift();
            if (waiter) waiter();
          };

          const doneResults = new Map<string, DoneToolResult | null>();
          const promises = tasks.map((task, idx) => {
            const hasDeps = task.dependsOn && task.dependsOn.length > 0;
            const jitter = Math.random() * STAGGER_MS;
            const delay = hasDeps ? 0 : idx * STAGGER_MS + jitter;

            const run = async () => {
              // Wait for dependencies BEFORE acquiring a concurrency slot.
              // Otherwise dependent agents hold slots while waiting, deadlocking
              // the agents they depend on from ever starting.
              // DependencyFailedError is caught so runAgentTask can handle it
              // gracefully (emit events, set bus result) instead of crashing Promise.all.
              if (hasDeps && task.dependsOn) {
                try {
                  await Promise.all(
                    task.dependsOn.map((dep) => bus.waitForAgent(dep, task.timeoutMs ?? 300_000)),
                  );
                } catch {
                  // Dep failed or timed out — fall through to runAgentTask which
                  // will detect the same condition and handle it with proper eventing
                }
              }
              await acquireConcurrencySlot();
              try {
                const { doneResult } = await runAgentTask(
                  task,
                  models,
                  bus,
                  toolCallId,
                  tasks.length,
                  combinedAbort,
                );
                doneResults.set(task.agentId, doneResult);
              } finally {
                releaseConcurrencySlot();
              }
            };

            return delay > 0 ? sleep(delay, combinedAbort).then(run) : run();
          });
          await Promise.all(promises);

          emitMultiAgentEvent({
            parentToolCallId: toolCallId,
            type: "dispatch-done",
            totalAgents: tasks.length,
            completedAgents: bus.completedAgentIds.length,
            findingCount: bus.findingCount,
          });

          const results = bus.getAllResults();
          const successful = results.filter((r) => r.success);
          const failed = results.filter((r) => !r.success);

          const sections: string[] = [];
          const heading = args.objective ?? "Dispatch";
          sections.push(`## ${heading}`);
          sections.push(
            `**${String(successful.length)}/${String(tasks.length)}** agents completed successfully.`,
          );

          if (bus.findingCount > 0) {
            const findings = bus.getFindings();
            sections.push(
              `### Coordination Findings (${String(findings.length)})`,
              ...findings.map((f) => `**[${f.agentId}] ${f.label}:**\n${f.content}`),
            );
          }

          for (const r of results) {
            const done = r.result.startsWith("[done]");
            const status = r.success ? (done ? "✓" : "⚠") : "✗";
            // Slim output: summary only + context file path. Full tool results are on disk.
            const taskSummary = r.task.split("\n")[0]?.slice(0, 200) ?? r.task.slice(0, 200);
            const contextPath = `.soulforge/dispatch/tab-${dispatchTabId}/${toolCallId}/${r.agentId}.md`;
            // Extract just the summary from [done] prefix — strip the verbose formatDoneResult output
            const summaryText = done
              ? (r.result
                  .replace(/^\[done\]\s*/, "")
                  .split("\n")[0]
                  ?.slice(0, 500) ?? r.result.slice(0, 500))
              : r.result.slice(0, 500);
            sections.push(
              `\n### ${status} Agent: ${r.agentId} (${r.role})\nTask: ${taskSummary}\n${summaryText}\n\nFull context: \`${contextPath}\`\n\n---`,
            );
          }

          const allGaps: string[] = [];
          const allConnections: string[] = [];
          for (const [agentId, done] of doneResults) {
            if (done?.gaps) allGaps.push(...done.gaps.map((g) => `[${agentId}] ${g}`));
            if (done?.connections)
              allConnections.push(...done.connections.map((c) => `[${agentId}] ${c}`));
          }
          if (allGaps.length > 0 || allConnections.length > 0) {
            const crossCut: string[] = ["\n### Cross-Cutting Analysis"];
            if (allGaps.length > 0) {
              crossCut.push("**Gaps:**", ...allGaps.map((g) => `- ${g}`));
            }
            if (allConnections.length > 0) {
              crossCut.push("**Connections:**", ...allConnections.map((c) => `- ${c}`));
            }
            sections.push(crossCut.join("\n"));
          }

          if (failed.length > 0) {
            sections.push(
              `\n### Errors\n${failed.map((r) => `- ${r.agentId}: ${r.error}`).join("\n")}`,
            );
          }

          const allEdited = bus.getEditedFiles();
          if (allEdited.size > 0) {
            const lines: string[] = [];
            const conflicts: string[] = [];
            for (const [path, agents] of allEdited) {
              lines.push(`- \`${path}\` — ${agents.join(", ")}`);
              if (agents.length > 1) conflicts.push(path);
            }
            sections.push(`\n### Files Edited\n${lines.join("\n")}`);
            if (conflicts.length > 0) {
              sections.push(
                `\n⚠ **Edit conflicts detected** — multiple agents edited: ${conflicts.map((p) => `\`${p}\``).join(", ")}. Review these files carefully.`,
              );
            }
          }

          const desloppifyResult = await runDesloppify(
            bus,
            tasks,
            models,
            toolCallId,
            combinedAbort,
          );
          if (desloppifyResult) sections.push(desloppifyResult);

          // Release git lock: code agents + desloppify are done editing.
          // Verifier is read-only (role: "explore", no edit tools) — safe to unlock.
          editingDone = true;
          if (activeTabId) getWorkspaceCoordinator().agentFinished(activeTabId);

          const verifyResult = await runVerifier(bus, tasks, models, toolCallId, combinedAbort);
          if (verifyResult) sections.push(verifyResult);

          const evalResult = await runEvaluator(bus, tasks, toolCallId);
          if (evalResult) sections.push(evalResult);

          const m = bus.metrics;
          const cacheStats = [m.fileHits, m.fileWaits, m.toolHits].some((v) => v > 0)
            ? `\n### Cache\nFiles: ${String(m.fileHits)} hits, ${String(m.fileWaits)} waits, ${String(m.fileMisses)} misses | Tools: ${String(m.toolHits)} hits, ${String(m.toolWaits)} waits, ${String(m.toolMisses)} misses, ${String(m.toolEvictions)} evictions, ${String(m.toolInvalidations)} invalidations`
            : "";
          if (cacheStats) sections.push(cacheStats);

          const editedPaths = [...allEdited.keys()];
          turnDispatchCount++;
          turnDispatchSummaries.push(
            `${args.objective ?? "Dispatch"}: ${String(successful.length)}/${String(tasks.length)} agents` +
              (editedPaths.length > 0 ? `, edited ${editedPaths.join(", ")}` : ""),
          );

          const allReads = bus.getFileReadRecords();
          return {
            reads: allReads,
            filesEdited: editedPaths,
            output: sections.join("\n") + dependentWarning,
          } satisfies DispatchOutput;
        } finally {
          if (activeTabId && !editingDone) getWorkspaceCoordinator().agentFinished(activeTabId);
          try {
            cacheRef.current = bus.exportCaches();
          } catch (err) {
            logBackgroundError("cache-export", err instanceof Error ? err.message : String(err));
          }
          bus.dispose();
        }
      },
      toModelOutput({ output }: { toolCallId: string; input: unknown; output: unknown }) {
        const dispatch = output as DispatchOutput | string;
        const rawText = typeof dispatch === "string" ? dispatch : dispatch.output;

        // Strip skill blocks echoed back from subagent prompts — main agent already has them
        const stripped = rawText.replace(
          /\n*--- Relevant skill: .+? ---\n[\s\S]*?(?=\n--- Relevant skill:|\n###|\n---\n|\n## |$)/g,
          "",
        );

        const lines = stripped.split("\n");
        const compact: string[] = [];
        let blankRun = 0;
        let inCodeBlock = false;
        let inStructuredSection = false;
        let truncatedLines = 0;

        for (const line of lines) {
          if (line.startsWith("```")) inCodeBlock = !inCodeBlock;
          if (/^(?:Files edited:|Key findings:|###.*Agent:)/.test(line)) {
            inStructuredSection = true;
          } else if (line.startsWith("## ") || line.startsWith("### Cache")) {
            inStructuredSection = false;
          }
          if (line.trim() === "") {
            blankRun++;
            if (blankRun <= 1) compact.push("");
            continue;
          }
          blankRun = 0;
          const limit = inCodeBlock || inStructuredSection ? 1500 : 600;
          if (line.length > limit) {
            truncatedLines++;
            compact.push(`${line.slice(0, limit)} [...]`);
          } else {
            compact.push(line);
          }
        }

        if (
          typeof dispatch !== "string" &&
          (dispatch.reads.length > 0 || dispatch.filesEdited.length > 0)
        ) {
          const header: string[] = [];
          if (dispatch.reads.length > 0) {
            header.push("Files already read by dispatch:");
            const seen = new Set<string>();
            for (const r of dispatch.reads) {
              const range =
                r.startLine != null
                  ? r.endLine != null
                    ? `:${String(r.startLine)}-${String(r.endLine)}`
                    : `:${String(r.startLine)}`
                  : "";
              const symbol = r.name
                ? ` ${r.target ?? ""} ${r.name}`
                : r.target === "scope"
                  ? " scope"
                  : "";
              const cache = r.cached ? " [cached]" : "";
              const label = `  ${r.tool} ${r.path}${range}${symbol}${cache}`;
              if (!seen.has(label)) {
                seen.add(label);
                header.push(label);
              }
            }
          }
          if (dispatch.filesEdited.length > 0) {
            header.push(`Files edited: ${dispatch.filesEdited.join(", ")}`);
          }
          header.push("These files are already in context. Do NOT re-read them.\n");
          compact.unshift(...header);
        }

        if (truncatedLines > 0) {
          compact.push(
            `\n[${String(truncatedLines)} long lines shortened — act on these results, do not re-read dispatched files]`,
          );
        }

        if (typeof dispatch !== "string") {
          compact.push(
            "\n---\n**Next step: act on these results.** FORBIDDEN: re-reading files that agents already examined. The findings above contain the code you need.",
          );
        }

        let value = compact.join("\n");
        const DISPATCH_OUTPUT_CAP = 24_000;
        if (value.length > DISPATCH_OUTPUT_CAP) {
          value = value.slice(0, DISPATCH_OUTPUT_CAP);
          const lastNl = value.lastIndexOf("\n");
          if (lastNl > 0) value = value.slice(0, lastNl);
          value += `\n[dispatch output capped at ${String(Math.round(DISPATCH_OUTPUT_CAP / 1024))}KB — use read_file for full file contents]`;
        }

        return { type: "text" as const, value };
      },
    }),
  };
}
