import { logBackgroundError } from "../../stores/errors.js";
import { projectTool } from "../tools/project.js";
import type { AgentBus, AgentTask } from "./agent-bus.js";
import { buildFallbackResult } from "./agent-results.js";
import { emitMultiAgentEvent } from "./subagent-events.js";
import { buildStepCallbacks, createAgent, type SubagentModels } from "./subagent-tools.js";

// ── De-sloppify ─────────────────────────────────────────────────────────
// Step 1: deterministic lint --fix (zero tokens)
// Step 2: LLM reviews for slop patterns the linter can't catch

const DESLOPPIFY_PROMPT = [
  "You are a cleanup agent. Lint --fix already ran on these files. Now review for slop the linter missed:",
  "- Tests that verify language/framework behavior rather than business logic",
  "- Redundant type assertions the type system already enforces (e.g. `as string` on a string)",
  "- Over-defensive error handling for impossible states (e.g. null checks after non-nullable returns)",
  "- console.log/debug/print statements not part of the feature",
  "- Dead code: unused variables, unreachable branches, empty catch blocks with no purpose",
  "",
  "KEEP (do NOT remove):",
  "- TODO/FIXME/SECTION/placeholder comments",
  "- Business logic, meaningful error handling, type annotations",
  "- Comments explaining non-obvious decisions",
  "",
  "WORKFLOW: read each file → multi_edit to fix slop → done.",
  "If the code is clean, report done immediately without reading.",
].join("\n");

export async function runDesloppify(
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
    // Step 1: deterministic lint --fix (zero tokens, instant)
    let lintResult = "";
    try {
      const lint = await projectTool.execute({ action: "lint", fix: true, timeout: 30_000 });
      if (!lint.success && lint.output) {
        const relevant = lint.output
          .split("\n")
          .filter((l: string) => editedPaths.some((p) => l.includes(p)));
        if (relevant.length > 0) lintResult = `\nLint issues after fix:\n${relevant.join("\n")}`;
      }
    } catch {}

    // Step 2: LLM cleanup pass
    const desloppifyTask: AgentTask = {
      agentId: "desloppify",
      role: "code",
      task: `${DESLOPPIFY_PROMPT}${lintResult}\n\nFiles to review:\n${editedPaths.map((p) => `- ${p}`).join("\n")}`,
    };

    bus.registerTasks([desloppifyTask]);

    const { agent } = createAgent(
      { ...desloppifyTask, tier: "standard" },
      { ...models, codingModel: models.desloppifyModel },
      bus,
      parentToolCallId,
    );

    const callbacks = buildStepCallbacks(parentToolCallId, "desloppify");
    // biome-ignore lint/suspicious/noExplicitAny: output schema may throw
    let result: any;
    try {
      result = await agent.generate({
        prompt: desloppifyTask.task,
        abortSignal,
        ...callbacks,
      });
    } catch (genErr: unknown) {
      const errWithSteps = genErr as { steps?: unknown[]; text?: string; totalUsage?: unknown };
      if (errWithSteps.steps && Array.isArray(errWithSteps.steps)) {
        result = {
          text: errWithSteps.text ?? "",
          output: undefined,
          steps: errWithSteps.steps,
          totalUsage: errWithSteps.totalUsage ?? { inputTokens: 0, outputTokens: 0 },
        };
        logBackgroundError(
          "desloppify",
          `Output schema failed: ${genErr instanceof Error ? genErr.message : String(genErr)}`,
        );
      } else {
        throw genErr;
      }
    }

    const resultText = buildFallbackResult(result);

    emitMultiAgentEvent({
      parentToolCallId,
      type: "agent-done",
      agentId: "desloppify",
      role: "code",
      task: `cleanup ${String(editedPaths.length)} files`,
      totalAgents: tasks.length + 1,
      tier: "desloppify",
    });

    if (resultText && resultText.length > 20) {
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

// ── Verifier ────────────────────────────────────────────────────────────
// Step 1: deterministic typecheck + test (zero tokens)
// Step 2: LLM checks logic correctness against the original task

const VERIFY_PROMPT = [
  "You are a verification agent in a SEPARATE context from the implementers — you did NOT write this code.",
  "",
  "Your job: verify the implementation is correct and complete against what was requested.",
  "",
  "PROCESS:",
  "1. Check the typecheck/test results provided below — errors are automatic FAIL",
  "2. Read each edited file and verify:",
  "   - Does the implementation match what the task asked for?",
  "   - Are there missing edge cases (empty input, null, zero, negative)?",
  "   - Are imports correct? Do exported signatures match what callers expect?",
  "   - Any race conditions, infinite loops, or resource leaks?",
  "3. If exports changed signatures, use navigate(action: references) to check one caller",
  "",
  "FORBIDDEN:",
  "- Do NOT fix formatting, style, or naming (de-sloppify already handled that)",
  "- Do NOT re-run typecheck or tests (results are provided below)",
  "- Do NOT modify files — only read and report",
  "",
  "OUTPUT: End with exactly one of:",
  "  VERDICT: PASS — [one-line summary of what was verified]",
  "  VERDICT: FAIL — [specific issues: file, line, what's wrong]",
  "  VERDICT: PARTIAL — [what couldn't be verified and why]",
].join("\n");

export async function runVerifier(
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
    role: "code",
    task: `verify ${String(editedPaths.length)} edited files`,
    totalAgents: tasks.length + 1,
    modelId:
      typeof reviewModel === "object" && "modelId" in reviewModel
        ? String(reviewModel.modelId)
        : "unknown",
    tier: "standard",
  });

  try {
    // Step 1: deterministic typecheck + test (zero tokens)
    const checkResults: string[] = [];
    try {
      const tc = await projectTool.execute({ action: "typecheck", timeout: 30_000 });
      if (!tc.success && tc.output) {
        const relevant = tc.output
          .split("\n")
          .filter((l: string) => editedPaths.some((p) => l.includes(p)));
        if (relevant.length > 0) {
          checkResults.push(`TYPECHECK FAILED:\n${relevant.join("\n")}`);
        } else {
          checkResults.push("Typecheck: passed (no errors in edited files)");
        }
      } else {
        checkResults.push("Typecheck: passed");
      }
    } catch {
      checkResults.push("Typecheck: unavailable");
    }

    try {
      const test = await projectTool.execute({ action: "test", timeout: 60_000 });
      if (!test.success && test.output) {
        checkResults.push(`TESTS FAILED:\n${test.output.slice(-500)}`);
      } else if (test.success) {
        checkResults.push("Tests: passed");
      }
    } catch {
      checkResults.push("Tests: unavailable");
    }

    // Step 2: LLM verification with context
    const taskContext = tasks
      .map((t) => {
        const r = bus.getResult(t.agentId);
        return r?.result ? `[${t.agentId}] task: ${t.task.split("\n")[0]?.slice(0, 200)}` : null;
      })
      .filter(Boolean)
      .join("\n");

    const verifyTask: AgentTask = {
      agentId: "verifier",
      role: "explore",
      task: [
        VERIFY_PROMPT,
        "",
        `--- Automated check results ---`,
        checkResults.join("\n"),
        "",
        `--- Files edited ---`,
        editedPaths.map((p) => `- ${p}`).join("\n"),
        "",
        `--- What was requested ---`,
        taskContext,
      ].join("\n"),
    };

    bus.registerTasks([verifyTask]);

    const { agent } = createAgent(
      verifyTask,
      { ...models, explorationModel: reviewModel },
      bus,
      parentToolCallId,
    );

    const callbacks = buildStepCallbacks(parentToolCallId, "verifier");
    // biome-ignore lint/suspicious/noExplicitAny: output schema may throw
    let result: any;
    try {
      result = await agent.generate({
        prompt: verifyTask.task,
        abortSignal,
        ...callbacks,
      });
    } catch (genErr: unknown) {
      const errWithSteps = genErr as { steps?: unknown[]; text?: string; totalUsage?: unknown };
      if (errWithSteps.steps && Array.isArray(errWithSteps.steps)) {
        result = {
          text: errWithSteps.text ?? "",
          output: undefined,
          steps: errWithSteps.steps,
          totalUsage: errWithSteps.totalUsage ?? { inputTokens: 0, outputTokens: 0 },
        };
        logBackgroundError(
          "verifier",
          `Output schema failed: ${genErr instanceof Error ? genErr.message : String(genErr)}`,
        );
      } else {
        throw genErr;
      }
    }

    const resultText = buildFallbackResult(result);

    emitMultiAgentEvent({
      parentToolCallId,
      type: "agent-done",
      agentId: "verifier",
      role: "code",
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
      role: "code",
      task: `verify ${String(editedPaths.length)} edited files`,
      totalAgents: tasks.length + 1,
      error: msg,
    });
    return null;
  }
}

/**
 * Evaluator: kept for backward compat. Verifier now does this + more.
 */
export async function runEvaluator(
  _bus: AgentBus,
  _tasks: AgentTask[],
  _parentToolCallId: string,
): Promise<string | null> {
  // Verifier now handles typecheck + test — evaluator is a no-op
  return null;
}
