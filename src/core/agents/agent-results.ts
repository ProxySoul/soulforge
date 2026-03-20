import type { FileReadRecord } from "./agent-bus.js";

export interface DoneToolResult {
  summary: string;
  filesEdited?: Array<{ file: string; changes: string }>;
  filesExamined?: string[];
  keyFindings?: Array<{ file: string; detail: string; lineNumbers?: string }>;
  gaps?: string[];
  connections?: string[];
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

const DONE_RESULT_CAP = 8000;
const PER_FILE_CONTENT_CAP = 2000;
const TEXT_TRUNCATION_CAP = 6000;
const SYNTHESIS_BUDGET = 8000;
const SUMMARY_MAX_LEN = 500;
const BUDGET_OVERHEAD = 50;
const MIN_CONTENT_LEN = 20;

export function extractDoneResult(result: AgentResult): DoneToolResult | null {
  for (let i = result.steps.length - 1; i >= 0; i--) {
    const step = result.steps[i];
    const doneCall = step?.toolCalls?.find((tc) => tc.toolName === "done");
    if (doneCall?.args) return doneCall.args as unknown as DoneToolResult;
  }
  return null;
}

export function buildFallbackResult(
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
        if (text && text.length > MIN_CONTENT_LEN && !text.includes("[Already in your context")) {
          // Cap per-file content to keep total reasonable
          const capped =
            text.length > PER_FILE_CONTENT_CAP
              ? `${text.slice(0, PER_FILE_CONTENT_CAP)}\n[... ${String(text.length - PER_FILE_CONTENT_CAP)} chars truncated]`
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
    parts.push(
      text.length > TEXT_TRUNCATION_CAP
        ? `${text.slice(0, TEXT_TRUNCATION_CAP)} [truncated]`
        : text,
    );
  }

  // Include agent's own report_finding calls as synthesis
  if (agentFindings && agentFindings.length > 0) {
    parts.push(...agentFindings.map((f) => `**${f.label}:**\n${f.content}`));
  }

  // Auto-synthesize from tool results when agent didn't call done
  if (readContents.length > 0 && !agentFindings?.length) {
    // Budget: ~8k chars total for all file contents
    let budget = SYNTHESIS_BUDGET;
    const findings: string[] = [];
    for (const { file, content } of readContents) {
      if (budget <= 0) break;
      const slice = content.slice(0, budget);
      findings.push(`--- ${file} ---\n${slice}`);
      budget -= slice.length + BUDGET_OVERHEAD;
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
export function synthesizeDoneFromResults(
  result: AgentResult,
  agentFindings: Array<{ label: string; content: string }>,
  task: { agentId: string; task: string; role: string },
): DoneToolResult {
  const filesRead = new Set<string>();
  const filesEdited = new Set<string>();
  const keyFindings: Array<{ file: string; detail: string }> = [];
  let budget = SYNTHESIS_BUDGET;

  // Extract from bus findings first (agent used report_finding)
  for (const f of agentFindings) {
    if (budget <= 0) break;
    const detail = f.content.slice(0, budget);
    keyFindings.push({ file: f.label, detail });
    budget -= detail.length + BUDGET_OVERHEAD;
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

      if (text.length < MIN_CONTENT_LEN || text.includes("[Already in your context")) continue;

      const capped = text.slice(0, Math.min(PER_FILE_CONTENT_CAP, budget));
      keyFindings.push({ file: filePath, detail: capped });
      budget -= capped.length + BUDGET_OVERHEAD;
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
      ? text.slice(0, SUMMARY_MAX_LEN)
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

export function formatDoneResult(done: DoneToolResult): string {
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
  if (done.gaps && done.gaps.length > 0) {
    parts.push("\nGaps:", ...done.gaps.map((g) => `  - ${g}`));
  }
  if (done.connections && done.connections.length > 0) {
    parts.push("\nConnections:", ...done.connections.map((c) => `  - ${c}`));
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
