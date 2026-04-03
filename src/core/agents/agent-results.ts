import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
    text?: string;
    toolCalls?: Array<{ toolName: string; args?: Record<string, unknown> }>;
    toolResults?: Array<{
      toolName: string;
      input?: unknown;
      output?: unknown;
    }>;
  }>;
};

const PER_FILE_CONTENT_CAP = 4000;
const TEXT_TRUNCATION_CAP = 12000;
const SYNTHESIS_BUDGET = 6000;
const BUDGET_OVERHEAD = 50;
const MIN_CONTENT_LEN = 20;

const READ_TOOLS = new Set(["read", "navigate", "soul_analyze"]);
const EDIT_TOOLS = new Set(["edit_file", "write_file", "create_file"]);
const SEARCH_TOOLS = new Set(["grep", "glob", "soul_grep", "soul_find", "soul_impact"]);

const STUB_PATTERNS = ["[Already in your context", "← file was edited", "←", "[cached]"];

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

/** Extract the agent's final text from the last step. Falls back to full result.text. */
export function extractFinalText(result: AgentResult): string {
  const lastStep = result.steps[result.steps.length - 1];
  const lastText = lastStep?.text?.trim();
  if (lastText && lastText.length > 10) return lastText;
  return typeof result.text === "string" ? result.text.trim() : "";
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
          ? `${text.slice(0, PER_FILE_CONTENT_CAP)}\n[... capped at ${String(Math.round(PER_FILE_CONTENT_CAP / 1000))}K chars]`
          : text;
      readContents.push({ file, content: capped });
    }
  }

  const parts: string[] = [];
  if (filesEdited.size > 0) parts.push(`Files edited: ${[...filesEdited].join(", ")}`);

  const text = result.text.trim();
  if (text) {
    parts.push(
      text.length > TEXT_TRUNCATION_CAP ? `${text.slice(0, TEXT_TRUNCATION_CAP)} [...]` : text,
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
 * Extracts actual code from read results so the parent gets usable content.
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

  // 2. Collect files from ALL tool calls (not just read)
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

  // This function is the last-resort fallback — agent didn't write meaningful text
  // and didn't call done. Synthesize from raw tool results.
  const text = result.text.trim();
  const summary =
    text.length > 10
      ? text
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
    parts.push(
      "\nKey findings:",
      ...done.keyFindings.map((f) => {
        const loc = f.lineNumbers ? `:${f.lineNumbers}` : "";
        return `  ${f.file}${loc}: ${f.detail}`;
      }),
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

  return parts.join("\n");
}

/**
 * Write agent context to disk for the parent agent to read on demand.
 * Deterministic extraction — zero LLM cost.
 * Returns the file path written.
 */
export async function writeAgentContext(
  dispatchId: string,
  agentId: string,
  task: { task: string; role: string },
  agentResult: AgentResult,
  findings: Array<{ label: string; content: string }>,
  agentText: string,
  cwd: string,
  tabId?: string,
): Promise<string> {
  const dir = tabId
    ? dispatchDir(cwd, tabId, dispatchId)
    : join(cwd, ".soulforge", "dispatch", dispatchId);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${agentId}.md`);

  const lines: string[] = [];
  lines.push(`# Agent: ${agentId} (${task.role})`);
  lines.push(`Task: ${task.task.slice(0, 300)}`);
  lines.push("");

  // Tool call stubs — what files/symbols were accessed
  const toolStubs: string[] = [];
  for (const step of agentResult.steps) {
    for (const tc of step.toolCalls ?? []) {
      const args = tc.args as Record<string, unknown> | undefined;
      const name = tc.toolName;
      if (name === "read") {
        const path = args?.path ?? args?.file ?? "";
        const start = args?.startLine ? ` lines ${String(args.startLine)}` : "";
        const end = args?.endLine ? `-${String(args.endLine)}` : "";
        const target = args?.target ? ` (${String(args.target)}: ${String(args.name ?? "")})` : "";
        toolStubs.push(`[read] ${String(path)}${start}${end}${target}`);
      } else if (name === "edit_file" || name === "multi_edit") {
        toolStubs.push(`[${name}] ${String(args?.path ?? "")}`);
      } else if (name === "grep" || name === "soul_grep") {
        toolStubs.push(`[${name}] /${String(args?.pattern ?? "")}/`);
      } else if (name === "navigate") {
        toolStubs.push(`[navigate] ${String(args?.action ?? "")} ${String(args?.symbol ?? "")}`);
      } else if (name === "analyze") {
        toolStubs.push(
          `[analyze] ${String(args?.action ?? "")} ${String(args?.file ?? args?.symbol ?? "")}`,
        );
      } else if (name === "soul_find") {
        toolStubs.push(`[soul_find] ${String(args?.query ?? "")}`);
      } else if (name === "soul_impact" || name === "soul_analyze") {
        toolStubs.push(`[${name}] ${String(args?.action ?? "")} ${String(args?.file ?? "")}`);
      } else if (name !== "done" && name !== "report_finding" && name !== "check_findings") {
        toolStubs.push(`[${name}]`);
      }
    }
  }
  if (toolStubs.length > 0) {
    lines.push("## Tool Calls");
    lines.push(...toolStubs);
    lines.push("");
  }

  // Findings from report_finding
  if (findings.length > 0) {
    lines.push("## Findings");
    for (const f of findings) {
      lines.push(`**${f.label}:**`);
      lines.push(f.content.slice(0, 2000));
      lines.push("");
    }
  }

  // Agent's own text summary
  if (agentText.trim()) {
    lines.push("## Agent Summary");
    lines.push(agentText.trim().slice(0, 4000));
    lines.push("");
  }

  await writeFile(filePath, lines.join("\n"), "utf-8");
  return filePath;
}

/**
 * Clean up dispatch context files from previous dispatches for a specific tab.
 * Tab-prefixed dirs (tab-<tabId>/) isolate dispatches across concurrent tabs.
 */
export async function cleanupDispatchDir(
  cwd: string,
  tabId: string,
  keepDispatchId?: string,
): Promise<void> {
  const tabDir = join(cwd, ".soulforge", "dispatch", `tab-${tabId}`);
  try {
    for (const entry of await readdir(tabDir)) {
      if (entry !== keepDispatchId) {
        try {
          await rm(join(tabDir, entry), { recursive: true });
        } catch {}
      }
    }
  } catch {}
}

/** Build the dispatch context dir path for a given tab + dispatch. */
function dispatchDir(cwd: string, tabId: string, dispatchId: string): string {
  return join(cwd, ".soulforge", "dispatch", `tab-${tabId}`, dispatchId);
}
