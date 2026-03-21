import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { type LanguageModel, NoObjectGeneratedError, NoOutputGeneratedError, RetryError } from "ai";
import { logBackgroundError } from "../../stores/errors.js";
import { taskListTool } from "../tools/task-list.js";
import {
  type AgentBus,
  type AgentTask,
  type AgentResult as BusAgentResult,
  DependencyFailedError,
  normalizePath,
} from "./agent-bus.js";
import {
  type DoneToolResult,
  extractDoneResult,
  formatDoneResult,
  synthesizeDoneFromResults,
} from "./agent-results.js";
import { emitMultiAgentEvent } from "./subagent-events.js";
import {
  autoPostCompletionSummary,
  buildStepCallbacks,
  createAgent,
  type SubagentModels,
} from "./subagent-tools.js";

const BASE_DELAY_MS = 2000;
const MAX_RETRIES = 3;

export const MAX_CONCURRENT_AGENTS = 3;
const AGENT_TIMEOUT_MS = 300_000;
const RETRY_JITTER_MS = 1000;

const RETURN_FORMAT_INSTRUCTIONS: Record<import("./agent-bus.js").ReturnFormat, string> = {
  summary:
    "Return concise findings and reasoning. No code blocks or raw file content. " +
    "Focus on what you found, what it means, and what the implications are.",
  code:
    "Return pasteable code snippets with file paths and line numbers. " +
    "Every finding MUST include the actual code. The parent agent is BLIND to your tool results.",
  files:
    "Return file paths only, each with a one-line description of what was found or changed. " +
    "No code blocks, no detailed analysis. Just the list.",
  full:
    "Return complete analysis: reasoning, code snippets, file paths, line numbers, and all details. " +
    "Paste full function bodies and type definitions in keyFindings — the parent cannot see your tool results.",
  verdict:
    "Return a clear yes/no answer with a brief justification (1-3 sentences). " +
    "No code blocks unless they directly support the verdict.",
};

function isRetryable(error: unknown, abortSignal?: AbortSignal): boolean {
  if (error instanceof DependencyFailedError) return false;
  // User-initiated abort (parent dispatch cancelled) — don't retry
  if (abortSignal?.aborted) return false;
  // AI SDK wraps retried failures in RetryError — always retry at our level too
  if (RetryError.isInstance(error)) return true;
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    lower.includes("overloaded") ||
    lower.includes("rate limit") ||
    lower.includes("429") ||
    lower.includes("529") ||
    lower.includes("503") ||
    lower.includes("too many requests") ||
    lower.includes("capacity") ||
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("etimedout") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("fetch failed") ||
    lower.includes("failed to fetch") ||
    lower.includes("cannot connect") ||
    lower.includes("network") ||
    lower.includes("socket hang up") ||
    lower.includes("aborted")
  );
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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

export function detectTaskTier(task: AgentTask): "trivial" | "standard" {
  if (task.tier) return task.tier;
  const t = task.task;
  const targetFileLine = t.split("\n").find((l) => l.startsWith("Target files:"));
  const targetFileCount = targetFileLine ? targetFileLine.split(",").length : 0;
  const isSingleFileRead = task.role === "explore" && targetFileCount <= 1 && t.length < 200;
  const isSmallEdit = task.role === "code" && targetFileCount <= 1 && t.length < 200;
  if (task.role === "investigate") return "standard";
  return isSingleFileRead || isSmallEdit ? "trivial" : "standard";
}

export function selectModel(task: AgentTask, models: SubagentModels): { model: LanguageModel } {
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

export function stripContextManagement(opts?: ProviderOptions): ProviderOptions | undefined {
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

export async function runAgentTask(
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
        task.dependsOn.map((dep) => bus.waitForAgent(dep, task.timeoutMs ?? AGENT_TIMEOUT_MS)),
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
  if (task.taskId != null) {
    taskListTool.execute({
      action: "update",
      id: task.taskId,
      status: "in-progress",
      tabId: task.tabId,
    });
  }

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

  const taskTargetFiles = new Set<string>();
  const targetMatch = task.task.match(/Target files:\n([\s\S]*?)(?:\n---|\n\n|$)/);
  if (targetMatch) {
    for (const line of targetMatch[1]?.split("\n") ?? []) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith(" ") && trimmed.includes("/")) {
        taskTargetFiles.add(normalizePath(trimmed));
      }
    }
  }

  if (taskTargetFiles.size > 0) {
    const peerTasks = bus.tasks.filter((t) => t.agentId !== task.agentId);
    const overlaps: string[] = [];
    for (const peer of peerTasks) {
      for (const file of taskTargetFiles) {
        if (peer.task.includes(file)) {
          overlaps.push(`${peer.agentId} also targets ${file}`);
        }
      }
    }
    if (overlaps.length > 0) {
      enrichedPrompt += `\n\nShared files: ${overlaps.join("; ")}. Check their findings before reading.`;
    }
  }

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

  if (task.returnFormat) {
    enrichedPrompt += `\n\n--- Return format: ${task.returnFormat} ---\n${RETURN_FORMAT_INSTRUCTIONS[task.returnFormat]}`;
  }

  let lastError: unknown;
  let attemptsMade = 0;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (abortSignal?.aborted) break;

    if (attempt > 0) {
      const jitter = Math.random() * RETRY_JITTER_MS;
      await sleep(BASE_DELAY_MS * 2 ** (attempt - 1) + jitter, abortSignal);
      if (abortSignal?.aborted) break;
    }

    try {
      attemptsMade = attempt + 1;
      const { agent } = createAgent(task, models, bus, parentToolCallId);
      const callbacks = buildStepCallbacks(parentToolCallId, task.agentId);

      // biome-ignore lint/suspicious/noExplicitAny: agent.generate result type varies with Output generic
      let result: any;
      try {
        result = await agent.generate({
          prompt: enrichedPrompt,
          abortSignal,
          timeout: { stepMs: 300_000 },
          ...callbacks,
        });
      } catch (genErr: unknown) {
        // Output.object() throws NoObjectGeneratedError when the model's final
        // response can't be parsed into the Zod schema (e.g. model returns "."
        // instead of JSON). ToolLoopAgent throws NoOutputGeneratedError when no
        // output is produced at all. Neither carries .steps, so we recover them
        // from the onStepFinish callback accumulator.
        const errWithSteps = genErr as { steps?: unknown[]; text?: string; totalUsage?: unknown };
        // Prefer steps from the error object, fall back to callback-accumulated steps
        const recoveredSteps =
          errWithSteps.steps && Array.isArray(errWithSteps.steps)
            ? errWithSteps.steps
            : callbacks._steps.length > 0
              ? callbacks._steps
              : [];

        if (
          errWithSteps.steps ||
          NoObjectGeneratedError.isInstance(genErr) ||
          NoOutputGeneratedError.isInstance(genErr)
        ) {
          const errObj = genErr as {
            text?: string;
            cause?: unknown;
            finishReason?: string;
            usage?: { inputTokens?: number; outputTokens?: number };
          };
          result = {
            text: errObj.text ?? "",
            output: undefined,
            steps: recoveredSteps,
            totalUsage: {
              inputTokens: errObj.usage?.inputTokens ?? callbacks._acc.input,
              outputTokens: errObj.usage?.outputTokens ?? callbacks._acc.output,
            },
          };
          const diagParts = [
            `Output schema failed (${String(recoveredSteps.length)} steps recovered): ${genErr instanceof Error ? genErr.message : String(genErr)}`,
          ];
          if (errObj.finishReason) diagParts.push(`finishReason: ${errObj.finishReason}`);
          if (errObj.cause)
            diagParts.push(
              `cause: ${errObj.cause instanceof Error ? errObj.cause.message : String(errObj.cause)}`,
            );
          logBackgroundError(task.agentId, diagParts.join("\n"));
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
            gaps?: string[];
            connections?: string[];
          }
        | undefined;
      if (outputData && typeof outputData.summary === "string") {
        const hasFindings = outputData.keyFindings && outputData.keyFindings.length > 0;
        const hasFiles = outputData.filesExamined && outputData.filesExamined.length > 0;
        // Only synthesize if the output schema is missing findings or files
        const synthesized =
          !hasFindings || !hasFiles ? synthesizeDoneFromResults(result, agentFindings, task) : null;
        doneResult = {
          summary: outputData.summary,
          filesExamined: hasFiles ? outputData.filesExamined : synthesized?.filesExamined,
          keyFindings: hasFindings ? outputData.keyFindings : synthesized?.keyFindings,
          gaps: outputData.gaps,
          connections: outputData.connections,
        };
        calledDone = true;
      }

      if (!doneResult) {
        doneResult = extractDoneResult(result);
        if (doneResult) calledDone = true;
      }

      if (!doneResult) {
        doneResult = synthesizeDoneFromResults(result, agentFindings, task);
        // When steps are empty (NoObjectGeneratedError recovery), enrich with bus file reads
        if (result.steps.length === 0) {
          const busReads = bus.getFileReadRecords(task.agentId);
          if (busReads.length > 0 && doneResult.filesExamined?.length === 0) {
            doneResult.filesExamined = busReads.map((r) => r.path);
          }
        }
        // Synthesis with real findings from bus or steps counts as done
        if (agentFindings.length > 0 || result.steps.length > 0) {
          calledDone = true;
        }
      }

      // Code agents that report done but edited nothing are false positives
      if (calledDone && task.role === "code") {
        const agentEdits = bus.getEditedFiles(task.agentId);
        if (agentEdits.size === 0) {
          calledDone = false;
        }
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
      if (task.taskId != null) {
        taskListTool.execute({
          action: "update",
          id: task.taskId,
          status: "done",
          tabId: task.tabId,
        });
      }
      return { doneResult, resultText, callbacks, result: agentResult };
    } catch (error) {
      lastError = error;
      if (isRetryable(error, abortSignal)) {
        const tripped = bus.recordProviderFailure();
        if (tripped || attempt === MAX_RETRIES) break;
      } else {
        break;
      }
    }
  }

  const errMsg =
    `Failed after ${String(attemptsMade)} attempt${attemptsMade === 1 ? "" : "s"}. ` +
    `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`;
  logBackgroundError(task.agentId, errMsg);

  const agentFindings = bus.getFindings().filter((f) => f.agentId === task.agentId);
  const agentReads = bus.getFileReadRecords(task.agentId);
  const agentEdits = [...bus.getEditedFiles().entries()]
    .filter(([_, editors]) => editors.includes(task.agentId))
    .map(([path]) => path);

  let salvaged = "";
  if (agentFindings.length > 0 || agentReads.length > 0 || agentEdits.length > 0) {
    const parts = [`Agent failed but produced partial results:`];
    if (agentReads.length > 0) {
      parts.push(`Files read: ${agentReads.map((r) => r.path).join(", ")}`);
    }
    if (agentEdits.length > 0) {
      parts.push(`Files edited: ${agentEdits.join(", ")}`);
    }
    for (const f of agentFindings) {
      parts.push(`Finding [${f.label}]: ${f.content}`);
    }
    salvaged = parts.join("\n");
  }

  const resultText = salvaged || errMsg;

  const agentResult: BusAgentResult = {
    agentId: task.agentId,
    role: task.role,
    task: task.task,
    result: resultText,
    success: salvaged.length > 0,
    error: errMsg,
  };
  bus.setResult(agentResult);

  emitMultiAgentEvent({
    parentToolCallId,
    type: salvaged ? "agent-done" : "agent-error",
    agentId: task.agentId,
    role: task.role,
    task: task.task,
    totalAgents,
    completedAgents: bus.completedAgentIds.length,
    findingCount: bus.findingCount,
    ...(salvaged ? {} : { error: errMsg }),
  });
  if (task.taskId != null) {
    taskListTool.execute({
      action: "update",
      id: task.taskId,
      status: salvaged ? "done" : "blocked",
      tabId: task.tabId,
    });
  }

  const doneResult: DoneToolResult | null = salvaged
    ? {
        summary: `Partial result (agent errored): ${errMsg.slice(0, 200)}`,
        filesExamined: agentReads.map((r) => r.path),
        ...(agentEdits.length > 0
          ? { filesEdited: agentEdits.map((f) => ({ file: f, changes: "edited" })) }
          : {}),
        keyFindings: agentFindings.map((f) => ({ file: f.label, detail: f.content })),
      }
    : null;

  return {
    doneResult,
    resultText,
    callbacks: buildStepCallbacks(parentToolCallId, task.agentId),
    result: agentResult,
  };
}
