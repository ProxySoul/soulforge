import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";

const coerceJsonArray = (v: unknown) => {
  if (typeof v !== "string") return v;
  const trimmed = v.trim();
  if (trimmed[0] === "[" || trimmed[0] === "{") {
    try {
      return JSON.parse(trimmed);
    } catch {
      return v;
    }
  }
  return v;
};

import type { InteractiveCallbacks, Plan, PlanDepth, PlanStepStatus } from "../../types/index.js";

function planFileName(sessionId?: string): string {
  return sessionId ? `plan-${sessionId}.md` : "plan.md";
}

export function buildInteractiveTools(
  callbacks: InteractiveCallbacks,
  opts?: { cwd?: string; sessionId?: string; forgeMode?: string },
) {
  const cwd = opts?.cwd ?? process.cwd();
  const forgeMode = opts?.forgeMode;
  const fname = planFileName(opts?.sessionId);

  return {
    plan: tool({
      description:
        "Create an implementation plan for large changes. Requires 7+ files — the system rejects plans with fewer files (edit directly instead). " +
        'depth "light": fast checklist (steps + files + guidance). depth "full": self-contained with code_snippets and old→new diffs.',
      inputSchema: z.object({
        depth: z
          .enum(["light", "full"])
          .describe(
            '"light" = fast checklist (no code_snippets/diffs). "full" = self-contained with code_snippets and diffs.',
          ),
        title: z.string().describe("Short plan title (2-6 words)"),
        context: z.string().describe("What problem this solves and why these changes are needed"),
        files: z
          .preprocess(
            coerceJsonArray,
            z.array(
              z.object({
                path: z
                  .string()
                  .describe("Exact file path from Soul Map or research — never guess"),
                action: z.enum(["create", "modify", "delete"]).describe("Type of change"),
                description: z.string().describe("What changes to make in this file"),
                symbols: z
                  .array(
                    z.object({
                      name: z.string().describe("Symbol name (function, class, type, variable)"),
                      kind: z
                        .string()
                        .describe(
                          "Symbol kind: function, class, interface, type, method, variable",
                        ),
                      action: z
                        .enum(["add", "modify", "remove", "rename"])
                        .describe("What to do with this symbol"),
                      details: z
                        .string()
                        .describe(
                          "Exact change: new signature, parameter changes, logic to add/remove. " +
                            "Include current signature for modifications.",
                        ),
                      line: z
                        .number()
                        .nullable()
                        .optional()
                        .describe("Current line number if modifying/removing"),
                    }),
                  )
                  .nullable()
                  .optional()
                  .catch(null)
                  .describe(
                    "Symbols to change in this file — include for all modify/delete actions",
                  ),
                code_snippets: z
                  .array(
                    z.object({
                      lines: z.string().describe("Line range, e.g. '10-45' or 'full'"),
                      code: z.string().describe("Exact current code copied from read output"),
                    }),
                  )
                  .nullable()
                  .optional()
                  .catch(null)
                  .describe(
                    "Current code from this file that the executor needs to see. " +
                      'Required for depth "full" on modify files. ' +
                      'Not needed for depth "light" — executor reads files on the fly.',
                  ),
              }),
            ),
          )
          .describe("All files to change — REQUIRED"),
        steps: z
          .preprocess(
            coerceJsonArray,
            z.array(
              z.object({
                id: z.string().describe("Step ID (step-1, step-2, etc.)"),
                label: z.string().describe("Short step label for the checklist"),
                targetFiles: z
                  .array(z.string())
                  .nullable()
                  .optional()
                  .catch(null)
                  .describe("File paths this step touches — executor opens only these"),
                edits: z
                  .array(
                    z.object({
                      file: z.string().describe("File path to edit"),
                      old: z.string().describe("Exact text to find (copy from code_snippets)"),
                      new: z.string().describe("Replacement text"),
                    }),
                  )
                  .nullable()
                  .optional()
                  .catch(null)
                  .describe(
                    "Concrete edit_file operations for this step. " +
                      'Required for depth "full" on modify steps. ' +
                      'Not needed for depth "light".',
                  ),
                shell: z
                  .string()
                  .nullable()
                  .optional()
                  .describe("Shell command to run in this step (e.g. install deps, run tests)"),
                details: z
                  .string()
                  .nullable()
                  .optional()
                  .describe("Additional context / guidance for the executor"),
              }),
            ),
          )
          .describe("Ordered implementation steps with full details"),
        verification: z
          .preprocess(coerceJsonArray, z.array(z.string()))
          .nullable()
          .optional()
          .catch(null)
          .describe("How to verify the changes work"),
      }),
      execute: async (args) => {
        const depth = args.depth as PlanDepth;
        const isFull = depth === "full";
        const errors: string[] = [];

        // Gate: reject plans for small changes — edit directly
        const fileCount = args.files.length;
        if (fileCount <= 6 && !forgeMode?.startsWith("plan")) {
          return {
            output:
              `Plan rejected — ${String(fileCount)} file${fileCount === 1 ? "" : "s"} doesn't need a plan. ` +
              "Edit files directly with read → multi_edit. Plans are for 7+ files or when the user explicitly asks (/plan mode).",
          };
        }

        if (isFull) {
          const modifiedFiles = new Set(
            args.files.filter((f) => f.action === "modify").map((f) => f.path),
          );

          for (const f of args.files) {
            if (f.action === "modify" && (!f.code_snippets || f.code_snippets.length === 0)) {
              errors.push(
                `\`${f.path}\` is marked modify but has no code_snippets. Read the file and paste the relevant code.`,
              );
            }
          }

          const stepEditFiles = new Set<string>();
          for (const s of args.steps) {
            if (s.edits) {
              for (const e of s.edits) stepEditFiles.add(e.file);
            }
          }
          for (const path of modifiedFiles) {
            if (!stepEditFiles.has(path)) {
              errors.push(
                `\`${path}\` is listed as modify but no step has edits for it. Add concrete old→new diffs.`,
              );
            }
          }
        }

        const validationWarnings =
          errors.length > 0
            ? `\n\n## Validation Warnings\n${errors.map((e) => `- ${e}`).join("\n")}`
            : "";

        const lines = [`# ${args.title}`, ""];
        if (isFull) {
          lines.push("_depth: full — self-contained plan_", "");
        } else {
          lines.push("_depth: light — executor keeps current context_", "");
        }
        lines.push(`## Context`, "", args.context, "", `## Files`);
        for (const f of args.files) {
          lines.push(`- **${f.action}** \`${f.path}\` — ${f.description}`);
          if (f.symbols?.length) {
            for (const s of f.symbols) {
              const loc = s.line ? `:${String(s.line)}` : "";
              lines.push(`  - ${s.action} \`${s.name}\` (${s.kind}${loc}): ${s.details}`);
            }
          }
          if (f.code_snippets?.length) {
            for (const snap of f.code_snippets) {
              lines.push(`  - **current code** [lines ${snap.lines}]:`);
              lines.push("    ```", ...snap.code.split("\n").map((l) => `    ${l}`), "    ```");
            }
          }
        }
        lines.push("", "## Steps");
        for (const s of args.steps) {
          lines.push(`### ${s.id}. ${s.label}`);
          if (s.targetFiles?.length) {
            lines.push("", `Files: ${s.targetFiles.map((f) => `\`${f}\``).join(", ")}`);
          }
          if (s.edits?.length) {
            for (const e of s.edits) {
              lines.push("", `**edit** \`${e.file}\`:`);
              lines.push("```diff");
              for (const ol of e.old.split("\n")) lines.push(`- ${ol}`);
              for (const nl of e.new.split("\n")) lines.push(`+ ${nl}`);
              lines.push("```");
            }
          }
          if (s.shell) {
            lines.push("", "```sh", s.shell, "```");
          }
          if (s.details) {
            lines.push("", s.details);
          }
          lines.push("");
        }
        if (args.verification?.length) {
          lines.push("## Verification");
          for (const v of args.verification) {
            lines.push(`- ${v}`);
          }
        }

        const dir = join(cwd, ".soulforge", "plans");
        await mkdir(dir, { recursive: true });
        const planContent = lines.join("\n") + validationWarnings;
        await writeFile(join(dir, fname), planContent);

        const plan: Plan = {
          title: args.title,
          depth,
          steps: args.steps.map((s) => ({
            id: s.id,
            label: s.label,
            status: "pending" as const,
          })),
          createdAt: Date.now(),
        };
        callbacks.onPlanCreate(plan);

        const action = await callbacks.onPlanReview(plan, `.soulforge/plans/${fname}`, planContent);

        const planFile = `.soulforge/plans/${fname}`;
        if (action === "execute") {
          return {
            success: true,
            file: planFile,
            output:
              "Plan confirmed. Execute step by step — update_plan_step(id, 'active') then update_plan_step(id, 'done') for each.",
          };
        }
        if (action === "clear_execute") {
          return {
            success: true,
            file: planFile,
            output: "Plan confirmed. Context will be cleared and plan re-submitted for execution.",
          };
        }
        if (action === "cancel" || action === "__skipped__") {
          return {
            success: true,
            file: planFile,
            output: "Plan cancelled by user. Wait for further instructions.",
          };
        }
        return {
          success: true,
          file: planFile,
          markdown: planContent,
          output:
            `User wants changes: "${action}". ` +
            "Research further if needed, then call `plan` again with the updated plan.",
        };
      },
    }),

    update_plan_step: tool({
      description:
        "Update the status of a plan step. Call this as you start and complete each step.",
      inputSchema: z.object({
        stepId: z.string().describe("The step ID to update"),
        status: z
          .enum(["pending", "active", "done", "skipped"])
          .describe("New status for the step"),
      }),
      execute: async (args) => {
        callbacks.onPlanStepUpdate(args.stepId, args.status as PlanStepStatus);
        return { success: true, output: `Step ${args.stepId}: ${args.status}` };
      },
    }),

    ask_user: tool({
      description:
        "Ask the user a question with selectable options. " +
        "Use when you need clarification or the user must choose between approaches. " +
        "Blocks until the user answers. Don't overuse — only when genuinely needed. " +
        "Keep the question brief (1-3 sentences). Put analysis in your response text, not in the question field.",
      inputSchema: z.object({
        question: z.string().describe("The question to ask"),
        options: z
          .preprocess(
            coerceJsonArray,
            z.array(
              z.object({
                label: z.string().describe("Display label"),
                value: z.string().describe("Value returned when selected"),
                description: z.string().nullable().optional().describe("Optional description"),
              }),
            ),
          )
          .describe("Selectable options"),
        allowSkip: z.boolean().nullable().optional().describe("Whether the user can skip (Esc)"),
      }),
      execute: async (args) => {
        const answer = await callbacks.onAskUser(
          args.question,
          args.options.map((o) => ({ ...o, description: o.description ?? undefined })),
          args.allowSkip ?? true,
        );
        return {
          success: true,
          output:
            answer === "__skipped__" ? "User skipped this question." : `User selected: ${answer}`,
        };
      },
    }),
  };
}
