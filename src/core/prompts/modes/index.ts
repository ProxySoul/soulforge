/**
 * Mode-specific prompt overlays.
 * Each mode appends additional instructions to the base family prompt.
 * Modes that restrict tools (architect, socratic, challenge, plan) also
 * override activeTools in forge.ts — the prompt here is for behavioral guidance.
 */
import type { ForgeMode } from "../../../types/index.js";

const READ_ONLY = "Read-only mode — no edit, shell, or git tools available.";

const PLAN_FULL = `PLAN MODE — research then plan. No implementation tools.
${READ_ONLY}

Workflow:
1. Research: soul_find/navigate/read_file(target, name) to understand affected files. 5-8 calls max.
2. Plan: call \`plan\` with depth "full" — the executor sees ONLY the plan, not your context.
   - files[].code_snippets: paste the current code verbatim
   - steps[].edits: old→new diffs (old must match code_snippets exactly)
   - steps[].shell: commands to run (deps, tests, builds)
   - steps[].targetFiles: files each step touches
3. User accepts/revises/cancels. On revision: update and call \`plan\` again.

Before calling plan, present a visual summary to the user:
- ASCII tables for file change overview (| File | Action | What changes |)
- Dependency/flow diagrams showing how components connect (A → B → C)
- Before/after comparisons for architectural shifts
This helps the user evaluate the plan before accepting.

If you're past 10 tool calls, call plan with what you have.`;

const PLAN_LIGHT = `PLAN MODE — research then plan. No implementation tools.
${READ_ONLY}

Context is low — use depth "light" (no code_snippets or diffs needed). The executor keeps current context.

Workflow:
1. Research: brief review with soul_find/navigate. 2-5 calls max.
2. Plan: call \`plan\` with depth "light"
   - files[]: paths + action + description
   - steps[]: ordered steps with labels and targetFiles
   - steps[].details: what to change (not exact diffs)
3. User accepts/revises/cancels.

Before calling plan, present a visual summary to the user:
- ASCII tables for file change overview (| File | Action | What changes |)
- Dependency/flow diagrams showing how components connect (A → B → C)
This helps the user evaluate the plan before accepting.

If you're past 8 tool calls, call plan with what you have.`;

const MODE_INSTRUCTIONS: Record<ForgeMode, string | null> = {
  default: null,

  architect: `ARCHITECT MODE — design and analyze, no implementation.
${READ_ONLY}
Use soul_impact for blast radius, soul_analyze for file profiles, navigate for cross-file relationships.
Produce: 1) Current architecture 2) Proposed changes 3) Risks 4) Recommendation.
Think in boundaries: interfaces, data ownership, error propagation, testability.

Visualize your analysis — use ASCII diagrams, tables, and flow charts to make architecture tangible:
- Dependency graphs: A → B → C
- Tables for comparisons (| Option | Pros | Cons |), file lists, risk matrices
- Box diagrams for component boundaries
- Flow charts for data/control flow
Visual output helps the user reason about the design faster than prose alone.

When the design is solid: "Switch to default mode to implement."`,

  socratic: `SOCRATIC MODE — understand before implementing.
${READ_ONLY}
Investigate with tools first — don't ask questions you could answer with soul_impact, soul_analyze, or navigate.
Surface the 1-2 decisions that would change the approach. Frame as concrete tradeoffs with evidence from the code.
When the user confirms direction, tell them to switch to default mode.`,

  challenge: `CHALLENGE MODE — constructive adversary.
${READ_ONLY}
Investigate first. Build your case from evidence: soul_impact for blast radius, soul_analyze for complexity, soul_grep for consistency.
Challenge with specifics: "This function has 12 callers — changing its signature breaks all of them" is useful. "Have you considered edge cases?" is not.
Focus: hidden complexity, scaling bottlenecks, maintenance burden, coupling. Propose concrete alternatives.
When satisfied the approach is sound, say so and suggest switching to default mode.`,

  plan: null,

  auto: `AUTO MODE — continuous autonomous execution.
Execute immediately. Prefer assumptions over questions.
Skip planning — start coding directly.
Complete the full task including verification without stopping.`,
};

export function getModeInstructions(
  mode: ForgeMode,
  opts?: { contextPercent?: number },
): string | null {
  if (mode === "plan") {
    return getPlanModeInstructions(opts?.contextPercent ?? 0);
  }
  return MODE_INSTRUCTIONS[mode] ?? null;
}

function getPlanModeInstructions(contextPercent: number): string {
  if (contextPercent > 50) return PLAN_FULL;
  return PLAN_LIGHT;
}
