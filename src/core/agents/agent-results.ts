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
const PER_FINDING_DISPLAY_CAP = 500;
const MAX_FINDINGS_DISPLAY = 5;
const TEXT_TRUNCATION_CAP = 6000;
const SYNTHESIS_BUDGET = 4000;
const SUMMARY_MAX_LEN = 500;
const BUDGET_OVERHEAD = 50;
const MIN_CONTENT_LEN = 20;

const READ_TOOLS = new Set(["read_file", "read_code", "navigate", "soul_analyze"]);
const EDIT_TOOLS = new Set(["edit_file", "write_file", "create_file"]);
const SEARCH_TOOLS = new Set(["grep", "glob", "soul_grep", "soul_find", "soul_impact"]);

const STUB_PATTERNS = ["[Already in your context", "[stale", "[summary]", "[pruned]", "[cached]"];

function extractPathFromArgs(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  const p = args.path ?? args.file ?? args.filePath;
  return typeof p === "string" ? p : undefined;
}

function extractText(raw: unknown): string {
  if (!raw) return "";
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.output === "string") return parsed.output;
    } catch {}
    return raw;
  }
  if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.output === "string") return obj.output;
    if (typeof obj.value === "string") return obj.value;
  }
  return String(raw);
}

function isStub(text: string): boolean {
  return STUB_PATTERNS.some((p) => text.startsWith(p) || text.includes(p));
}

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
      const path = extractPathFromArgs(tc.args as Record<string, unknown> | undefined);
      if (path) {
        if (READ_TOOLS.has(tc.toolName) || SEARCH_TOOLS.has(tc.toolName)) filesRead.add(path);
        if (EDIT_TOOLS.has(tc.toolName)) filesEdited.add(path);
      }
    }
    for (const tr of step.toolResults ?? []) {
      if (!READ_TOOLS.has(tr.toolName) && !SEARCH_TOOLS.has(tr.toolName)) continue;
      const input = tr.input as Record<string, unknown> | undefined;
      const file = extractPathFromArgs(input) ?? tr.toolName;
      const text = extractText(tr.output);
      if (text.length < MIN_CONTENT_LEN || isStub(text)) continue;
      const capped =
        text.length > PER_FILE_CONTENT_CAP
          ? `${text.slice(0, PER_FILE_CONTENT_CAP)}\n[... ${String(text.length - PER_FILE_CONTENT_CAP)} chars truncated]`
          : text;
      readContents.push({ file, content: capped });
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

  // 1. Bus findings first — highest quality (agent curated via report_finding)
  for (const f of agentFindings) {
    if (budget <= 0) break;
    const detail = f.content.slice(0, budget);
    keyFindings.push({ file: f.label, detail });
    budget -= detail.length + BUDGET_OVERHEAD;
  }

  // 2. Collect files from ALL tool calls (not just read_file)
  for (const step of result.steps) {
    for (const tc of step.toolCalls ?? []) {
      const args = tc.args as Record<string, unknown> | undefined;
      const path = extractPathFromArgs(args);
      if (path) {
        if (READ_TOOLS.has(tc.toolName) || SEARCH_TOOLS.has(tc.toolName)) filesRead.add(path);
        if (EDIT_TOOLS.has(tc.toolName)) filesEdited.add(path);
      }
    }
  }

  // 3. Extract content from tool results (reads, greps, analysis)
  const seenFiles = new Set(keyFindings.map((kf) => kf.file));
  for (const step of result.steps) {
    if (budget <= 0) break;
    for (const tr of step.toolResults ?? []) {
      if (budget <= 0) break;
      if (!READ_TOOLS.has(tr.toolName) && !SEARCH_TOOLS.has(tr.toolName)) continue;

      const input = tr.input as Record<string, unknown> | undefined;
      const filePath = extractPathFromArgs(input) ?? tr.toolName;
      if (seenFiles.has(filePath)) continue;

      const text = extractText(tr.output);
      if (text.length < MIN_CONTENT_LEN || isStub(text)) continue;

      seenFiles.add(filePath);
      const capped = text.slice(0, Math.min(PER_FILE_CONTENT_CAP, budget));
      keyFindings.push({ file: filePath, detail: capped });
      budget -= capped.length + BUDGET_OVERHEAD;
    }
  }

  // 4. Fallback — list files touched if nothing else
  if (keyFindings.length === 0) {
    const allFiles = [...filesRead, ...filesEdited];
    keyFindings.push({
      file: allFiles[0] ?? task.task.slice(0, 80),
      detail:
        allFiles.length > 0
          ? `Examined ${String(allFiles.length)} files: ${allFiles.join(", ")}`
          : `No tool results captured for: ${task.task.slice(0, 200)}`,
    });
  }

  const text = result.text.trim();
  const summary =
    text.length > 10
      ? text.slice(0, SUMMARY_MAX_LEN)
      : `Examined ${String(filesRead.size)} files for: ${task.task.slice(0, 100)}`;

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
    const shown = done.keyFindings.slice(0, MAX_FINDINGS_DISPLAY);
    const omitted = done.keyFindings.length - shown.length;
    parts.push(
      "\nKey findings:",
      ...shown.map((f) => {
        const loc = f.lineNumbers ? `:${f.lineNumbers}` : "";
        const detail =
          f.detail.length > PER_FINDING_DISPLAY_CAP
            ? `${f.detail.slice(0, PER_FINDING_DISPLAY_CAP)} [${String(f.detail.length - PER_FINDING_DISPLAY_CAP)} chars omitted — use read_file for full content]`
            : f.detail;
        return `  ${f.file}${loc}: ${detail}`;
      }),
    );
    if (omitted > 0) {
      const files = done.keyFindings
        .slice(MAX_FINDINGS_DISPLAY)
        .map((f) => f.file)
        .join(", ");
      parts.push(`  ... ${String(omitted)} more findings in: ${files}`);
    }
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
