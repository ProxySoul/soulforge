import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import type { InteractiveCallbacks, Plan, PlanDepth, PlanStepStatus } from "../../types/index.js";

function planFileName(sessionId?: string): string {
  return sessionId ? `plan-${sessionId}.md` : "plan.md";
}

export function buildInteractiveTools(
  callbacks: InteractiveCallbacks,
  opts?: { cwd?: string; sessionId?: string },
) {
  const cwd = opts?.cwd ?? process.cwd();
  const fname = planFileName(opts?.sessionId);

  return {
    plan: tool({
      description:
        "Create an implementation plan. User confirms before execution. " +
        'depth "light": fast checklist — just steps, files, and guidance. No code_snippets or diffs needed. ' +
        'depth "full": self-contained plan with code_snippets and old→new diffs for Clear & Implement. ' +
        "Follow the depth guidance in the Forge Mode instructions.",
      inputSchema: z.object({
        depth: z
          .enum(["light", "full"])
          .describe(
            '"light" = fast checklist (no code_snippets/diffs). "full" = self-contained with code_snippets and diffs.',
          ),
        title: z.string().describe("Short plan title (2-6 words)"),
        context: z.string().describe("What problem this solves and why these changes are needed"),
        files: z
          .array(
            z.object({
              path: z.string().describe("Exact file path from Repo Map or research — never guess"),
              action: z.enum(["create", "modify", "delete"]).describe("Type of change"),
              description: z.string().describe("What changes to make in this file"),
              symbols: z
                .array(
                  z.object({
                    name: z.string().describe("Symbol name (function, class, type, variable)"),
                    kind: z
                      .string()
                      .describe("Symbol kind: function, class, interface, type, method, variable"),
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
                      .optional()
                      .describe("Current line number if modifying/removing"),
                  }),
                )
                .optional()
                .catch(undefined)
                .describe("Symbols to change in this file — include for all modify/delete actions"),
              code_snippets: z
                .array(
                  z.object({
                    lines: z.string().describe("Line range, e.g. '10-45' or 'full'"),
                    code: z
                      .string()
                      .describe("Exact current code copied from read_file/read_code output"),
                  }),
                )
                .optional()
                .catch(undefined)
                .describe(
                  "Current code from this file that the executor needs to see. " +
                    'Required for depth "full" on modify files. ' +
                    'Not needed for depth "light" — executor reads files on the fly.',
                ),
            }),
          )
          .describe("All files to change — REQUIRED"),
        steps: z
          .array(
            z.object({
              id: z.string().describe("Step ID (step-1, step-2, etc.)"),
              label: z.string().describe("Short step label for the checklist"),
              targetFiles: z
                .array(z.string())
                .optional()
                .catch(undefined)
                .describe("File paths this step touches — executor opens only these"),
              edits: z
                .array(
                  z.object({
                    file: z.string().describe("File path to edit"),
                    old: z.string().describe("Exact text to find (copy from code_snippets)"),
                    new: z.string().describe("Replacement text"),
                  }),
                )
                .optional()
                .catch(undefined)
                .describe(
                  "Concrete edit_file operations for this step. " +
                    'Required for depth "full" on modify steps. ' +
                    'Not needed for depth "light".',
                ),
              shell: z
                .string()
                .optional()
                .describe("Shell command to run in this step (e.g. install deps, run tests)"),
              details: z
                .string()
                .optional()
                .default("")
                .describe("Additional context / guidance for the executor"),
            }),
          )
          .describe("Ordered implementation steps with full details"),
        verification: z
          .array(z.string())
          .optional()
          .catch(undefined)
          .describe("How to verify the changes work"),
      }),
      execute: async (args) => {
        const depth = args.depth as PlanDepth;
        const isFull = depth === "full";
        const errors: string[] = [];

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
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const planContent = lines.join("\n") + validationWarnings;
        writeFileSync(join(dir, fname), planContent);

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

    editor_panel: tool({
      description:
        "Open the editor panel for the user. " +
        "Optionally specify a file path to open in the editor. " +
        "Use this when you want to show the user a file in the embedded neovim editor.",
      inputSchema: z.object({
        file: z.string().optional().describe("File path to open in the editor"),
      }),
      execute: async (args) => {
        await callbacks.onOpenEditor(args.file);
        return {
          success: true,
          output: args.file ? `Opened ${args.file} in editor` : "Editor panel opened",
        };
      },
    }),

    ask_user: tool({
      description:
        "Ask the user a question with selectable options. " +
        "Use when you need clarification or the user must choose between approaches. " +
        "Blocks until the user answers. Don't overuse — only when genuinely needed.",
      inputSchema: z.object({
        question: z.string().describe("The question to ask"),
        options: z
          .array(
            z.object({
              label: z.string().describe("Display label"),
              value: z.string().describe("Value returned when selected"),
              description: z.string().optional().describe("Optional description"),
            }),
          )
          .describe("Selectable options"),
        allowSkip: z.boolean().optional().describe("Whether the user can skip (Esc)"),
      }),
      execute: async (args) => {
        const answer = await callbacks.onAskUser(
          args.question,
          args.options,
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
