import type { ForgeMode } from "../../types/index.js";

const READ_ONLY =
  "Read-only mode. No edit/shell/git tools. Available: read_file, grep, glob, web_search, fetch_page, navigate, read_code, analyze, memory, dispatch (explore).";

const PLAN_FULL = [
  "PLAN MODE — research then plan. Implementation tools are unavailable.",
  READ_ONLY,
  'Context is above 50% — use depth: "full" so the plan is self-contained for Clear & Implement.',
  "Workflow:",
  "1. Use discover_pattern to map the architecture. Read only the files you'll modify — use read_code for files over 100 lines.",
  '2. Call `plan` with depth "full" as soon as you have enough context. Do not read extra files for confirmation.',
  "   - files[].code_snippets: paste current code (executor sees only the plan)",
  "   - steps[].edits: old→new diffs (old must be verbatim from code_snippets)",
  "   - steps[].shell: commands to run (deps, tests, builds)",
  "   - steps[].targetFiles: files each step touches",
  "3. System prompts user to accept/revise/cancel. On revision: update plan, call `plan` again.",
  "Bias toward action: 5-8 tool calls should be enough research for most tasks. If you're past 10, call plan with what you have.",
].join("\n");

const PLAN_LIGHT = [
  "PLAN MODE — research then plan. Implementation tools are unavailable.",
  READ_ONLY,
  'Context is low — use depth: "light" for a fast plan (just steps, no code_snippets or diffs needed).',
  "The executor keeps the current context and can read files on the fly.",
  "Workflow:",
  "1. Briefly review the architecture with discover_pattern. Skim the files you'll modify — read_code for large files.",
  '2. Call `plan` with depth "light" as soon as you understand the shape of the change.',
  "   - files[]: list paths + action + description (no code_snippets needed)",
  "   - steps[]: ordered steps with labels and targetFiles (no edits/diffs needed)",
  "   - steps[].details: brief guidance for each step (what to change, not exact diffs)",
  "   - steps[].shell: commands to run if any",
  "3. System prompts user to accept/revise/cancel. On revision: update plan, call `plan` again.",
  "Bias toward action: 2-5 tool calls should be enough research. If you're past 8, call plan with what you have.",
].join("\n");

const MODE_INSTRUCTIONS: Record<ForgeMode, string | null> = {
  default: null,
  architect: [
    "ARCHITECT MODE — design only, no implementation.",
    READ_ONLY,
    "Produce: architecture outlines, dependency analysis, tradeoffs, risk assessments.",
    "Focus: component boundaries, data flow, error handling, testing.",
    'When ready: "Switch to default mode to implement."',
  ].join("\n"),
  socratic: [
    "SOCRATIC MODE — question before implementing.",
    READ_ONLY,
    "For every request ask: 1) Why this over alternatives? 2) Failure modes? 3) 2+ alternatives with risk analysis.",
    "When confirmed: tell user to switch to default mode.",
  ].join("\n"),
  challenge: [
    "CHALLENGE MODE — constructive adversary.",
    READ_ONLY,
    "Challenge assumptions. Propose counter-approaches. Point out: hidden complexity, scaling, maintenance, security.",
    "Respectful but relentless. When satisfied: switch to default mode.",
  ].join("\n"),
  plan: null, // handled dynamically by getPlanModeInstructions
};

export function getModeInstructions(
  mode: ForgeMode,
  opts?: { contextPercent?: number },
): string | null {
  if (mode === "plan") {
    return getPlanModeInstructions(opts?.contextPercent ?? 0);
  }
  return MODE_INSTRUCTIONS[mode];
}

function getPlanModeInstructions(contextPercent: number): string {
  if (contextPercent > 50) return PLAN_FULL;
  return PLAN_LIGHT;
}
