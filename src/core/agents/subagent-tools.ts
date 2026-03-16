import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { logBackgroundError } from "../../stores/errors.js";
import type { AgentFeatures } from "../../types/index.js";
import type { RepoMap } from "../intelligence/repo-map.js";
import { projectTool } from "../tools/project.js";
import {
  AgentBus,
  type AgentTask,
  type AgentResult as BusAgentResult,
  DependencyFailedError,
  type FileReadRecord,
  normalizePath,
  type SharedCache,
} from "./agent-bus.js";
import { createCodeAgent } from "./code.js";
import { createExploreAgent } from "./explore.js";
import { emitAgentStats, emitMultiAgentEvent, emitSubagentStep } from "./subagent-events.js";

export interface SharedCacheRef {
  current: SharedCache | undefined;
  updateFile(path: string, content: string): void;
}

interface SubagentModels {
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

function buildStepCallbacks(parentToolCallId: string, agentId?: string) {
  const acc = { toolUses: 0, input: 0, output: 0, cacheRead: 0 };

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
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        inputTokenDetails?: { cacheReadTokens?: number };
      };
    }) => {
      acc.toolUses += step.toolCalls?.length ?? 0;
      acc.input += step.usage?.inputTokens ?? 0;
      acc.output += step.usage?.outputTokens ?? 0;
      acc.cacheRead += step.usage?.inputTokenDetails?.cacheReadTokens ?? 0;
      if (agentId) {
        emitAgentStats({
          parentToolCallId,
          agentId,
          toolUses: acc.toolUses,
          tokenUsage: { input: acc.input, output: acc.output, total: acc.input + acc.output },
          cacheHits: acc.cacheRead,
        });
      }
    },
    _acc: acc,
  };
}

function autoPostCompletionSummary(bus: AgentBus, task: AgentTask): void {
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

interface DoneToolResult {
  summary: string;
  filesEdited?: Array<{ file: string; changes: string }>;
  filesExamined?: string[];
  keyFindings?: Array<{ file: string; detail: string; lineNumbers?: string }>;
  verified?: boolean;
  verificationOutput?: string;
}

export interface DispatchOutput {
  reads: FileReadRecord[];
  filesEdited: string[];
  output: string;
}

type AgentResult = {
  text: string;
  output?: unknown;
  steps: Array<{
    toolCalls?: Array<{ toolName: string; args?: Record<string, unknown> }>;
    toolResults?: Array<{
      toolName: string;
      input?: unknown;
      output?: unknown;
    }>;
  }>;
};

function extractDoneResult(result: AgentResult): DoneToolResult | null {
  for (let i = result.steps.length - 1; i >= 0; i--) {
    const step = result.steps[i];
    const doneCall = step?.toolCalls?.find((tc) => tc.toolName === "done");
    if (doneCall?.args) return doneCall.args as unknown as DoneToolResult;
  }
  return null;
}

function buildFallbackResult(
  result: AgentResult,
  agentFindings?: Array<{ label: string; content: string }>,
): string {
  const filesRead = new Set<string>();
  const filesEdited = new Set<string>();
  const readContents: Array<{ file: string; content: string }> = [];

  for (const step of result.steps) {
    for (const tc of step.toolCalls ?? []) {
      const path = tc.args?.path as string | undefined;
      if (path) {
        if (tc.toolName === "read_file" || tc.toolName === "read_code") filesRead.add(path);
        if (tc.toolName === "edit_file") filesEdited.add(path);
      }
    }
    // Extract content from tool results (the actual code the agent read)
    for (const tr of step.toolResults ?? []) {
      if (tr.toolName === "read_file" || tr.toolName === "read_code") {
        const input = tr.input as Record<string, unknown> | undefined;
        const file = (input?.path ?? input?.file) as string | undefined;
        const raw = tr.output;
        if (!file || !raw) continue;
        const content = typeof raw === "string" ? raw : JSON.stringify(raw);
        // Extract the actual output content from JSON wrapper if present
        let text = content;
        try {
          const parsed = JSON.parse(content) as { output?: string; success?: boolean };
          if (parsed.output && parsed.success !== false) text = parsed.output;
        } catch {}
        if (text && text.length > 20 && !text.includes("[Already in your context")) {
          // Cap per-file content to keep total reasonable
          const capped =
            text.length > 2000
              ? `${text.slice(0, 2000)}\n[... ${String(text.length - 2000)} chars truncated]`
              : text;
          readContents.push({ file, content: capped });
        }
      }
    }
  }

  const parts: string[] = [];
  if (filesEdited.size > 0) parts.push(`Files edited: ${[...filesEdited].join(", ")}`);

  const text = result.text.trim();
  if (text) {
    parts.push(text.length > 6000 ? `${text.slice(0, 6000)} [truncated]` : text);
  }

  // Include agent's own report_finding calls as synthesis
  if (agentFindings && agentFindings.length > 0) {
    parts.push(...agentFindings.map((f) => `**${f.label}:**\n${f.content}`));
  }

  // Auto-synthesize from tool results when agent didn't call done
  if (readContents.length > 0 && !agentFindings?.length) {
    // Budget: ~8k chars total for all file contents
    let budget = 8000;
    const findings: string[] = [];
    for (const { file, content } of readContents) {
      if (budget <= 0) break;
      const slice = content.slice(0, budget);
      findings.push(`--- ${file} ---\n${slice}`);
      budget -= slice.length + 50;
    }
    parts.push(
      `(Agent exhausted steps without calling done. Auto-extracted content from ${String(readContents.length)} file(s):)\n` +
        findings.join("\n\n"),
    );
  } else if (filesRead.size > 0) {
    parts.push(
      `(Agent did not call done — no synthesis produced. Read ${String(filesRead.size)} files: ${[...filesRead].join(", ")}. ` +
        "File contents are in the dispatch cache.)",
    );
  }

  return parts.join("\n");
}

/**
 * Auto-synthesize a DoneToolResult from the agent's tool results when done wasn't called.
 * Extracts actual code from read_file/read_code results so the parent gets usable content.
 * This guarantees 100% done results — the parent ALWAYS gets structured output.
 */
function synthesizeDoneFromResults(
  result: AgentResult,
  agentFindings: Array<{ label: string; content: string }>,
  task: { agentId: string; task: string; role: string },
): DoneToolResult {
  const filesRead = new Set<string>();
  const filesEdited = new Set<string>();
  const keyFindings: Array<{ file: string; detail: string }> = [];
  let budget = 8000;

  // Extract from bus findings first (agent used report_finding)
  for (const f of agentFindings) {
    if (budget <= 0) break;
    const detail = f.content.slice(0, budget);
    keyFindings.push({ file: f.label, detail });
    budget -= detail.length + 50;
  }

  // Extract from tool results (actual code the agent read)
  for (const step of result.steps) {
    for (const tc of step.toolCalls ?? []) {
      const path = (tc.args as Record<string, unknown> | undefined)?.path as string | undefined;
      const file = (tc.args as Record<string, unknown> | undefined)?.file as string | undefined;
      const resolvedPath = path ?? file;
      if (resolvedPath) {
        if (tc.toolName === "read_file" || tc.toolName === "read_code") filesRead.add(resolvedPath);
        if (tc.toolName === "edit_file") filesEdited.add(resolvedPath);
      }
    }

    if (budget <= 0) continue;

    for (const tr of step.toolResults ?? []) {
      if (budget <= 0) break;
      if (tr.toolName !== "read_file" && tr.toolName !== "read_code") continue;
      const input = tr.input as Record<string, unknown> | undefined;
      const filePath = (input?.path ?? input?.file) as string | undefined;
      if (!filePath) continue;

      // Skip if we already have a finding for this file from bus
      if (keyFindings.some((kf) => kf.file === filePath)) continue;

      const raw = tr.output;
      if (!raw) continue;
      let text = typeof raw === "string" ? raw : JSON.stringify(raw);
      try {
        const parsed = JSON.parse(text) as { output?: string; success?: boolean };
        if (parsed.output && parsed.success !== false) text = parsed.output;
      } catch {}

      if (text.length < 20 || text.includes("[Already in your context")) continue;

      const capped = text.slice(0, Math.min(2000, budget));
      keyFindings.push({ file: filePath, detail: capped });
      budget -= capped.length + 50;
    }
  }

  // Ensure at least one finding (schema requires min 1)
  if (keyFindings.length === 0) {
    keyFindings.push({
      file: task.agentId,
      detail: `Agent read ${String(filesRead.size)} files: ${[...filesRead].join(", ")}`,
    });
  }

  const text = result.text.trim();
  const summary =
    text.length > 10
      ? text.slice(0, 500)
      : `Auto-synthesized: examined ${String(filesRead.size)} files for task "${task.task.slice(0, 100)}"`;

  return {
    summary,
    filesExamined: [...filesRead],
    ...(filesEdited.size > 0
      ? { filesEdited: [...filesEdited].map((f) => ({ file: f, changes: "edited" })) }
      : {}),
    keyFindings,
  };
}

const DONE_RESULT_CAP = 8000;

function formatDoneResult(done: DoneToolResult): string {
  const parts: string[] = [done.summary];

  if (done.filesEdited && done.filesEdited.length > 0) {
    parts.push("\nFiles edited:", ...done.filesEdited.map((f) => `  ${f.file}: ${f.changes}`));
  }
  if (done.filesExamined && done.filesExamined.length > 0) {
    parts.push(`\nFiles examined: ${done.filesExamined.join(", ")}`);
  }
  if (done.keyFindings && done.keyFindings.length > 0) {
    parts.push(
      "\nKey findings:",
      ...done.keyFindings.map(
        (f) => `  ${f.file}${f.lineNumbers ? `:${f.lineNumbers}` : ""}: ${f.detail}`,
      ),
    );
  }
  if (done.verified != null) {
    parts.push(`\nVerified: ${done.verified ? "yes" : "no"}`);
    if (done.verificationOutput) parts.push(done.verificationOutput);
  }

  const result = parts.join("\n");
  if (result.length > DONE_RESULT_CAP) {
    return `${result.slice(0, DONE_RESULT_CAP)}\n[truncated — ${String(result.length - DONE_RESULT_CAP)} chars omitted]`;
  }
  return result;
}

async function runEvaluator(
  bus: AgentBus,
  tasks: AgentTask[],
  parentToolCallId: string,
): Promise<string | null> {
  const codeAgents = tasks.filter((t) => t.role === "code");
  if (codeAgents.length === 0) return null;

  const editedFiles = bus.getEditedFiles();
  if (editedFiles.size === 0) return null;

  emitMultiAgentEvent({
    parentToolCallId,
    type: "dispatch-eval",
    totalAgents: tasks.length,
  });

  try {
    const result = await projectTool.execute({
      action: "typecheck",
      timeout: 30_000,
    });

    if (result.success) return null;
    if (
      !result.output ||
      result.output === "No typecheck command detected for this project. Use shell to run manually."
    )
      return null;

    const editedPaths = [...editedFiles.keys()];
    const relevantErrors = result.output
      .split("\n")
      .filter((l: string) => editedPaths.some((p) => l.includes(p)));

    if (relevantErrors.length === 0) return null;

    return `\n\n### Post-dispatch validation\n⚠ Errors in edited files:\n${relevantErrors.join("\n")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logBackgroundError("post-dispatch-eval", msg);
    return null;
  }
}

const DESLOPPIFY_PROMPT = [
  "You are a cleanup agent. Review the files that were just edited and remove:",
  "- Tests that verify language/framework behavior rather than business logic",
  "- Redundant type checks the type system already enforces",
  "- Over-defensive error handling for impossible states",
  "- console.log/debug statements",
  "- Commented-out code",
  "- Unnecessary empty lines or formatting noise",
  "",
  "Keep all business logic tests and meaningful error handling.",
  "Run typecheck/lint after cleanup to verify nothing breaks.",
  "If the code is already clean, call done immediately.",
].join("\n");

async function runDesloppify(
  bus: AgentBus,
  tasks: AgentTask[],
  models: SubagentModels,
  parentToolCallId: string,
  abortSignal?: AbortSignal,
): Promise<string | null> {
  if (models.agentFeatures?.desloppify === false) return null;
  const codeAgents = tasks.filter((t) => t.role === "code");
  if (codeAgents.length === 0) return null;
  if (!models.desloppifyModel) return null;

  const editedFiles = bus.getEditedFiles();
  if (editedFiles.size === 0) return null;

  const editedPaths = [...editedFiles.keys()];

  emitMultiAgentEvent({
    parentToolCallId,
    type: "agent-start",
    agentId: "desloppify",
    role: "code",
    task: `cleanup ${String(editedPaths.length)} files`,
    totalAgents: tasks.length + 1,
    modelId:
      typeof models.desloppifyModel === "object" && "modelId" in models.desloppifyModel
        ? String(models.desloppifyModel.modelId)
        : "unknown",
    tier: "desloppify",
  });

  try {
    const desloppifyTask: AgentTask = {
      agentId: "desloppify",
      role: "code",
      task: `${DESLOPPIFY_PROMPT}\n\nFiles to review:\n${editedPaths.map((p) => `- ${p}`).join("\n")}`,
    };

    bus.registerTasks([desloppifyTask]);

    const { agent } = createAgent(
      { ...desloppifyTask, tier: "standard" },
      { ...models, codingModel: models.desloppifyModel },
      bus,
    );

    const callbacks = buildStepCallbacks(parentToolCallId, "desloppify");
    const result = await agent.generate({
      prompt: desloppifyTask.task,
      abortSignal,
      ...callbacks,
    });

    const doneResult = extractDoneResult(result);
    const resultText = doneResult ? formatDoneResult(doneResult) : buildFallbackResult(result);

    emitMultiAgentEvent({
      parentToolCallId,
      type: "agent-done",
      agentId: "desloppify",
      role: "code",
      task: `cleanup ${String(editedPaths.length)} files`,
      totalAgents: tasks.length + 1,
      tier: "desloppify",
    });

    if (doneResult?.filesEdited && doneResult.filesEdited.length > 0) {
      return `\n\n### De-sloppify pass\n${resultText}`;
    }
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logBackgroundError("desloppify", msg);
    emitMultiAgentEvent({
      parentToolCallId,
      type: "agent-error",
      agentId: "desloppify",
      role: "code",
      task: `cleanup ${String(editedPaths.length)} files`,
      totalAgents: tasks.length + 1,
      error: msg,
    });
    return null;
  }
}

const VERIFY_PROMPT = [
  "You are a verification specialist. Your job is not to confirm the implementation works — it is to try to break it.",
  "",
  "RECOGNIZE YOUR RATIONALIZATIONS:",
  '- "The code looks correct" — reading is not verification. Run typecheck/lint/tests.',
  '- "The tests pass" — the implementer is an LLM. Its tests may be circular or mock-heavy. Verify independently.',
  '- "This is probably fine" — probably is not verified. Check it.',
  "",
  "PROCESS:",
  "1. Read each edited file with read_code to understand what changed",
  "2. Run project typecheck — type errors in edited files are automatic FAIL",
  "3. Run project lint — lint errors in edited files are FAIL",
  "4. Run project test if tests exist — failures are FAIL",
  "5. Check for logic issues: missing error handling, race conditions, broken imports, unused variables",
  "6. Check the changes make sense in context: read callers/importers of modified exports",
  "",
  "OUTPUT: End your done call summary with exactly one of:",
  "  VERDICT: PASS",
  "  VERDICT: FAIL — [specific issues]",
  "  VERDICT: PARTIAL — [what could not be verified and why]",
  "",
  "PASS means you ran checks and found no issues. FAIL means you found concrete problems. PARTIAL means tooling was unavailable.",
  "If the code is trivial (config change, comment, rename) and typecheck passes, PASS quickly.",
].join("\n");

async function runVerifier(
  bus: AgentBus,
  tasks: AgentTask[],
  models: SubagentModels,
  parentToolCallId: string,
  abortSignal?: AbortSignal,
): Promise<string | null> {
  if (models.agentFeatures?.verifyEdits === false) return null;
  const codeAgents = tasks.filter((t) => t.role === "code");
  if (codeAgents.length === 0) return null;

  const reviewModel = models.verifyModel ?? models.explorationModel ?? models.defaultModel;

  const editedFiles = bus.getEditedFiles();
  if (editedFiles.size === 0) return null;

  const editedPaths = [...editedFiles.keys()];

  emitMultiAgentEvent({
    parentToolCallId,
    type: "agent-start",
    agentId: "verifier",
    role: "explore",
    task: `verify ${String(editedPaths.length)} edited files`,
    totalAgents: tasks.length + 1,
    modelId:
      typeof reviewModel === "object" && "modelId" in reviewModel
        ? String(reviewModel.modelId)
        : "unknown",
    tier: "standard",
  });

  try {
    const verifyTask: AgentTask = {
      agentId: "verifier",
      role: "explore",
      task: `${VERIFY_PROMPT}\n\nFiles edited by code agents:\n${editedPaths.map((p) => `- ${p}`).join("\n")}`,
    };

    bus.registerTasks([verifyTask]);

    const { agent } = createAgent(verifyTask, { ...models, explorationModel: reviewModel }, bus);

    const callbacks = buildStepCallbacks(parentToolCallId, "verifier");
    const result = await agent.generate({
      prompt: verifyTask.task,
      abortSignal,
      ...callbacks,
    });

    const doneResult = extractDoneResult(result);
    const resultText = doneResult ? formatDoneResult(doneResult) : buildFallbackResult(result);

    emitMultiAgentEvent({
      parentToolCallId,
      type: "agent-done",
      agentId: "verifier",
      role: "explore",
      task: `verify ${String(editedPaths.length)} edited files`,
      totalAgents: tasks.length + 1,
    });

    return `\n\n### Verification\n${resultText}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logBackgroundError("verifier", msg);
    emitMultiAgentEvent({
      parentToolCallId,
      type: "agent-error",
      agentId: "verifier",
      role: "explore",
      task: `verify ${String(editedPaths.length)} edited files`,
      totalAgents: tasks.length + 1,
      error: msg,
    });
    return null;
  }
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;
const MAX_CONCURRENT_AGENTS = 3;

function isRetryable(error: unknown): boolean {
  if (error instanceof DependencyFailedError) return false;
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    lower.includes("overloaded") ||
    lower.includes("rate limit") ||
    lower.includes("429") ||
    lower.includes("529") ||
    lower.includes("503") ||
    lower.includes("too many requests") ||
    lower.includes("capacity")
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function detectTaskTier(task: AgentTask): "trivial" | "standard" {
  if (task.tier) return task.tier;
  const t = task.task;
  const targetFileLine = t.split("\n").find((l) => l.startsWith("Target files:"));
  const targetFileCount = targetFileLine ? targetFileLine.split(",").length : 0;
  const isSingleFileRead = task.role === "explore" && targetFileCount <= 1 && t.length < 200;
  const isSmallEdit = task.role === "code" && targetFileCount <= 1 && t.length < 200;
  if (task.role === "investigate") return "standard";
  return isSingleFileRead || isSmallEdit ? "trivial" : "standard";
}

function selectModel(task: AgentTask, models: SubagentModels): { model: LanguageModel } {
  const tier = detectTaskTier(task);
  const useExplore =
    task.role === "explore" || task.role === "investigate" || models.readOnly === true;

  if (tier === "trivial" && models.trivialModel && models.agentFeatures?.tierRouting !== false) {
    return { model: models.trivialModel };
  }

  const base = useExplore
    ? (models.explorationModel ?? models.defaultModel)
    : (models.codingModel ?? models.defaultModel);
  return { model: base };
}

function stripContextManagement(opts?: ProviderOptions): ProviderOptions | undefined {
  if (!opts) return opts;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [provider, val] of Object.entries(opts)) {
    if (val && typeof val === "object" && "contextManagement" in val) {
      const { contextManagement: _, ...rest } = val as Record<string, unknown>;
      out[provider] = rest;
      changed = true;
    } else {
      out[provider] = val;
    }
  }
  return changed ? (out as ProviderOptions) : opts;
}

function createAgent(
  task: AgentTask,
  models: SubagentModels,
  bus: AgentBus,
  // biome-ignore lint/suspicious/noExplicitAny: explore/code agents have different tool generics
): { agent: any; modelId: string; tier: string } {
  const useExplore =
    task.role === "explore" || task.role === "investigate" || models.readOnly === true;
  const { model } = selectModel(task, models);
  const tier = detectTaskTier(task);
  const subagentProviderOptions = stripContextManagement(models.providerOptions);
  const opts = {
    bus,
    agentId: task.agentId,
    providerOptions: subagentProviderOptions,
    headers: models.headers,
    webSearchModel: models.webSearchModel,
    onApproveWebSearch: models.onApproveWebSearch,
    onApproveFetchPage: models.onApproveFetchPage,
    repoMap: models.repoMap,
  };
  const agent = useExplore ? createExploreAgent(model, opts) : createCodeAgent(model, opts);
  const modelId =
    typeof model === "object" && "modelId" in model ? String(model.modelId) : "unknown";
  return { agent, modelId, tier };
}

async function runAgentTask(
  task: AgentTask,
  models: SubagentModels,
  bus: AgentBus,
  parentToolCallId: string,
  totalAgents: number,
  abortSignal?: AbortSignal,
): Promise<{
  doneResult: DoneToolResult | null;
  resultText: string;
  callbacks: ReturnType<typeof buildStepCallbacks>;
  result: BusAgentResult;
}> {
  if (task.dependsOn && task.dependsOn.length > 0) {
    try {
      await Promise.all(
        task.dependsOn.map((dep) => bus.waitForAgent(dep, task.timeoutMs ?? 300_000)),
      );
    } catch (err) {
      if (err instanceof DependencyFailedError) {
        const errMsg = `Skipped: dependency "${err.depAgentId}" failed`;
        const agentResult = {
          agentId: task.agentId,
          role: task.role,
          task: task.task,
          result: errMsg,
          success: false,
          error: errMsg,
        } satisfies BusAgentResult;
        bus.setResult(agentResult);
        emitMultiAgentEvent({
          parentToolCallId,
          type: "agent-error",
          agentId: task.agentId,
          role: task.role,
          task: task.task,
          totalAgents,
          error: errMsg,
        });
        return {
          doneResult: null,
          resultText: errMsg,
          callbacks: buildStepCallbacks(parentToolCallId, task.agentId),
          result: agentResult,
        };
      }
      throw err;
    }
  }

  const taskTier = detectTaskTier(task);
  const { model: selectedModel } = selectModel(task, models);
  const selectedModelId =
    typeof selectedModel === "object" && "modelId" in selectedModel
      ? String(selectedModel.modelId)
      : "unknown";

  emitMultiAgentEvent({
    parentToolCallId,
    type: "agent-start",
    agentId: task.agentId,
    role: task.role,
    task: task.task,
    totalAgents,
    modelId: selectedModelId,
    tier: taskTier,
  });

  const peerFindings = bus.summarizeFindings(task.agentId);
  const depResults = task.dependsOn
    ?.map((dep) => {
      const r = bus.getResult(dep);
      return r ? `[${dep}] completed:\n${r.result}` : null;
    })
    .filter(Boolean)
    .join("\n\n");

  const peerObjectives = bus.getPeerObjectives(task.agentId);

  const failedDeps =
    task.dependsOn?.filter((dep) => {
      const r = bus.getResult(dep);
      return r && !r.success;
    }) ?? [];

  let enrichedPrompt = task.task;
  if (peerObjectives) {
    enrichedPrompt += `\n\n--- Peer agents ---\n${peerObjectives}`;
  }
  if (depResults) {
    enrichedPrompt += `\n\n--- Dependency results ---\n${depResults}`;
    if (failedDeps.length > 0) {
      enrichedPrompt += `\n\nWARNING: ${failedDeps.join(", ")} failed. Adapt your approach.`;
    }
  }
  if (peerFindings !== "No findings from peer agents yet.") {
    enrichedPrompt += `\n\n--- Peer findings so far ---\n${peerFindings}`;
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (abortSignal?.aborted) break;

    if (attempt > 0) {
      const jitter = Math.random() * 1000;
      await sleep(BASE_DELAY_MS * 2 ** (attempt - 1) + jitter, abortSignal);
      if (abortSignal?.aborted) break;
    }

    try {
      const { agent } = createAgent(task, models, bus);
      const callbacks = buildStepCallbacks(parentToolCallId, task.agentId);

      // biome-ignore lint/suspicious/noExplicitAny: agent.generate result type varies with Output generic
      let result: any;
      try {
        result = await agent.generate({
          prompt: enrichedPrompt,
          abortSignal,
          ...callbacks,
        });
      } catch (genErr: unknown) {
        // Output schema can throw NoOutputGeneratedError if the model fails to
        // produce valid structured JSON after the tool loop. The steps are done —
        // extract them from the error and synthesize results.
        const errWithSteps = genErr as { steps?: unknown[]; text?: string; totalUsage?: unknown };
        if (errWithSteps.steps && Array.isArray(errWithSteps.steps)) {
          result = {
            text: errWithSteps.text ?? "",
            output: undefined,
            steps: errWithSteps.steps,
            totalUsage: errWithSteps.totalUsage ?? { inputTokens: 0, outputTokens: 0 },
          };
          // Log the output schema failure for /errors
          const { logBackgroundError } = await import("../../stores/errors.js");
          logBackgroundError(
            task.agentId,
            `Output schema failed: ${genErr instanceof Error ? genErr.message : String(genErr)}`,
          );
        } else {
          throw genErr;
        }
      }

      const toolUses =
        callbacks._acc.toolUses ||
        result.steps.reduce(
          (sum: number, s: { toolCalls?: unknown[] }) => sum + (s.toolCalls?.length ?? 0),
          0,
        );
      const input = callbacks._acc.input || (result.totalUsage.inputTokens ?? 0);
      const output = callbacks._acc.output || (result.totalUsage.outputTokens ?? 0);
      const cacheRead =
        callbacks._acc.cacheRead || (result.totalUsage.inputTokenDetails?.cacheReadTokens ?? 0);

      // Three sources for structured results (priority order):
      // 1. Output schema (SDK-generated structured data after loop ends)
      // 2. Done tool (agent explicitly called done with curated content)
      // 3. Auto-synthesize from tool results + bus findings (guaranteed fallback)
      const agentFindings = bus.getFindings().filter((f) => f.agentId === task.agentId);
      let doneResult: DoneToolResult | null = null;
      let calledDone = false;

      const outputData = result.output as
        | {
            summary?: string;
            filesExamined?: string[];
            keyFindings?: Array<{ file: string; detail: string }>;
          }
        | undefined;
      if (outputData?.summary && outputData.keyFindings && outputData.keyFindings.length > 0) {
        doneResult = {
          summary: outputData.summary,
          filesExamined: outputData.filesExamined,
          keyFindings: outputData.keyFindings,
        };
        calledDone = true;
      }

      if (!doneResult) {
        doneResult = extractDoneResult(result);
        if (doneResult) calledDone = true;
      }

      if (!doneResult) {
        doneResult = synthesizeDoneFromResults(result, agentFindings, task);
      }

      const resultText = formatDoneResult(doneResult);

      const agentResult: BusAgentResult = {
        agentId: task.agentId,
        role: task.role,
        task: task.task,
        result: calledDone ? `[done] ${resultText}` : `[no-done] ${resultText}`,
        success: true,
      };
      bus.setResult(agentResult);

      autoPostCompletionSummary(bus, task);

      emitMultiAgentEvent({
        parentToolCallId,
        type: "agent-done",
        agentId: task.agentId,
        role: task.role,
        task: task.task,
        totalAgents,
        completedAgents: bus.completedAgentIds.length,
        findingCount: bus.findingCount,
        toolUses,
        tokenUsage: { input, output, total: input + output },
        cacheHits: cacheRead > 0 ? cacheRead : undefined,
        resultChars: resultText.length,
        modelId: selectedModelId,
        tier: taskTier,
        calledDone,
      });
      return { doneResult, resultText, callbacks, result: agentResult };
    } catch (error) {
      lastError = error;
      if (isRetryable(error)) {
        const tripped = bus.recordProviderFailure();
        if (tripped || attempt === MAX_RETRIES) break;
      } else {
        break;
      }
    }
  }

  const errMsg =
    `Failed after ${String(MAX_RETRIES)} attempts. ` +
    `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`;

  const agentResult: BusAgentResult = {
    agentId: task.agentId,
    role: task.role,
    task: task.task,
    result: errMsg,
    success: false,
    error: errMsg,
  };
  bus.setResult(agentResult);

  emitMultiAgentEvent({
    parentToolCallId,
    type: "agent-error",
    agentId: task.agentId,
    role: task.role,
    task: task.task,
    totalAgents,
    error: errMsg,
  });

  return {
    doneResult: null,
    resultText: errMsg,
    callbacks: buildStepCallbacks(parentToolCallId, task.agentId),
    result: agentResult,
  };
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
        "Dispatch parallel subagents. Provide a contract listing ALL files you need — the system verifies them against the Repo Map and rejects hallucinated paths. " +
        "If you need ≤6 files, the system rejects dispatch and tells you to read directly (with Repo Map symbol info). " +
        "BEFORE dispatching: can you answer from the Repo Map + ≤5 direct tool calls? If yes, don't dispatch. " +
        'Task format: "Read [symbol] from [path]. Return full implementation." Every task MUST name specific files and symbols. ' +
        "Include line numbers from the Repo Map when available. " +
        "Split by file ownership, not concept. explore: read-only. code: edits (distinct files per agent). " +
        "Web search: ONE focused query per task.",
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
                  "Exact file paths from the Repo Map that this task targets. Web search tasks use ['web'].",
                ),
              role: z
                .enum(["explore", "code", "investigate"])
                .default("explore")
                .describe(
                  "explore = targeted extraction, investigate = broad cross-cutting analysis (scans with soul_grep/soul_analyze/grep), code = edits",
                ),
              id: z.string().optional().describe("Unique ID (auto-generated if omitted)"),
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
                "ALL file paths you need across all tasks. Must be exact paths from the Repo Map. The system verifies these exist before approving dispatch.",
              ),
            reason: z
              .string()
              .min(10)
              .describe(
                "Why dispatch instead of direct reads? Must justify why this requires parallel agents rather than sequential read_code/read_file calls.",
              ),
          })
          .describe(
            "REQUIRED. List every file you need and justify why dispatch is necessary. " +
              "The system verifies files against the Repo Map and rejects hallucinated paths. " +
              "If you need ≤6 files, the system will tell you to read them directly.",
          ),
      }),
      execute: async (rawArgs, { abortSignal, toolCallId }) => {
        const bus = new AgentBus(cacheRef.current);
        try {
          const WEB_MARKER = "web";

          // Contract verification — validate files against Repo Map before proceeding
          if (!rawArgs.contract && !rawArgs.force) {
            return (
              "⛔ dispatch [rejected → no contract]\n" +
              "Provide a contract listing ALL files you need (contract.filesNeeded) and why dispatch is needed (contract.reason). " +
              "The system verifies files against the Repo Map before approving. " +
              "If you need ≤6 files, read them directly instead of dispatching."
            );
          }
          if (rawArgs.contract && !rawArgs.force) {
            const contract = rawArgs.contract;
            const repoMap = models.repoMap;
            const verified: string[] = [];
            const hallucinated: string[] = [];
            const onDiskOnly: string[] = [];
            const cwd = process.cwd();

            for (const file of contract.filesNeeded) {
              const norm = normalizePath(file);
              if (norm === "web") continue;

              // Tier 1: Repo Map (most reliable — has symbols, line ranges)
              if (repoMap) {
                const symbols = repoMap.getFileSymbolRanges(norm);
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
                `\nCheck the Repo Map for correct paths. Use soul_find if you're unsure of a filename.`
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

            // Completeness check: for code tasks, warn about missing dependents
            if (repoMap) {
              const codeFiles = rawArgs.tasks
                .filter((t) => t.role === "code")
                .flatMap((t) => t.targetFiles.map(normalizePath));
              if (codeFiles.length > 0) {
                const missingDeps: string[] = [];
                for (const f of codeFiles) {
                  const importers = repoMap.getFileDependents(f);
                  for (const imp of importers.slice(0, 5)) {
                    if (!contractSet.has(imp.path) && !codeFiles.includes(imp.path)) {
                      missingDeps.push(`\`${imp.path}\` imports \`${f}\``);
                    }
                  }
                }
                if (missingDeps.length > 0) {
                  const depList = [...new Set(missingDeps)].slice(0, 5).join("\n  ");
                  return (
                    `⚠️ dispatch [rejected → missing dependents]\n` +
                    `Code edits may break importers not in your contract:\n  ${depList}\n` +
                    `Add them to contract.filesNeeded or set force: true if they don't need updates.`
                  );
                }
              }
            }

            // Threshold: ≤6 files → reject with enriched Repo Map info
            const totalFiles = verified.length + onDiskOnly.length;
            const MAX_DIRECT_FILES = 6;
            if (totalFiles > 0 && totalFiles <= MAX_DIRECT_FILES) {
              const fileList: string[] = [];
              for (const f of verified) {
                if (repoMap) {
                  const symbols = repoMap.getFileSymbolRanges(f);
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
                fileList.push(`  \`${f}\` (not in Repo Map — use read_file)`);
              }
              return (
                `⛔ dispatch [rejected → read directly]\n` +
                `You only need ${String(totalFiles)} file(s) — read them directly:\n` +
                fileList.join("\n") +
                `\nUse read_code for specific symbols or read_file for full files. Dispatch is for 7+ files or parallel edits.`
              );
            }
          }

          if (models.agentFeatures?.targetFileValidation !== false) {
            for (const t of rawArgs.tasks) {
              const isWebTask =
                t.targetFiles.length === 1 && t.targetFiles[0]?.toLowerCase() === WEB_MARKER;
              if (isWebTask) continue;

              const hasFilePaths = t.targetFiles.some((f) => f.includes("/") || f.includes("."));
              if (!hasFilePaths) {
                return `⛔ dispatch [rejected → invalid targetFiles]\nTask "${t.id ?? "?"}" has no valid file paths in targetFiles. Every non-web task must reference specific files from the Repo Map. Got: [${t.targetFiles.join(", ")}]`;
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
                `Act on these results before dispatching again. If they lack what you need, use read_file/read_code/soul_grep for targeted follow-up. ` +
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

            const webTasks = args.tasks.filter(
              (t) => t.targetFiles.length === 1 && t.targetFiles[0]?.toLowerCase() === WEB_MARKER,
            );
            if (webTasks.length > 2) {
              return `⛔ dispatch [rejected → too many web tasks]\n${String(webTasks.length)} web search tasks is excessive (max 2). Check the conversation for URLs the user already shared (use fetch_page) and previous search results before searching again. Set force: true only after confirming existing context lacks the answer.`;
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
                  `⛔ dispatch [rejected → too few files]\n${String(uniqueFiles.size)} file${uniqueFiles.size === 1 ? "" : "s"} (${fileList}) — read directly with read_code or read_file. ` +
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
            return {
              agentId: t.id ?? `agent-${String(i + 1)}`,
              role: t.role,
              task: `${t.task}${fileHint}`,
              dependsOn: t.dependsOn,
            };
          });

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
            return {
              reads: bus.getFileReadRecords(task.agentId),
              filesEdited: edited,
              output: postParts.length > 0 ? `${resultText}\n${postParts.join("\n")}` : resultText,
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

          const promises = tasks.map((task, idx) => {
            const hasDeps = task.dependsOn && task.dependsOn.length > 0;
            const jitter = Math.random() * STAGGER_MS;
            const delay = hasDeps ? 0 : idx * STAGGER_MS + jitter;

            const run = async () => {
              await acquireConcurrencySlot();
              try {
                await runAgentTask(task, models, bus, toolCallId, tasks.length, combinedAbort);
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
            const doneTag = done ? " [done]" : " [no-done]";
            sections.push(
              `\n### ${status} Agent: ${r.agentId} (${r.role})${doneTag}\nTask: ${r.task}\n\n${r.result}\n\n---`,
            );
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

          return {
            reads: bus.getFileReadRecords(),
            filesEdited: editedPaths,
            output: sections.join("\n"),
          } satisfies DispatchOutput;
        } finally {
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

        const lines = rawText.split("\n");
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
            compact.push(`${line.slice(0, limit)} [truncated]`);
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
          header.push("All file content from these reads is included below. Act on it directly.\n");
          compact.unshift(...header);
        }

        if (truncatedLines > 0) {
          compact.push(
            `\n[${String(truncatedLines)} lines compacted — use read_file/read_code on specific files if you need full content]`,
          );
        }

        if (typeof dispatch !== "string") {
          compact.push(
            "\n---\n**Next step: act on these results.** You have the dispatch output above — plan your implementation, write code, or respond to the user. " +
              "Reading files that dispatch already returned wastes a tool call (the cache will block the re-read). " +
              "If you need a specific symbol from a large file, use read_code with the symbol name.",
          );
        }

        return { type: "text" as const, value: compact.join("\n") };
      },
    }),
  };
}
