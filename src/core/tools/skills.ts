import { tool } from "ai";
import { z } from "zod";
import type { ContextManager } from "../context/manager.js";
import { installSkill, listInstalledSkills, loadSkill, searchSkills } from "../skills/manager.js";

function humanInstalls(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const TRUSTED_SOURCES = new Set([
  "vercel-labs/agent-skills",
  "vercel-labs/skills",
  "anthropics/skills",
  "microsoft/skills",
  "google-labs-code/stitch-skills",
  "vercel/next.js",
]);

function formatSearchResult(s: {
  name: string;
  installs: number;
  source: string;
  id: string;
}): string {
  const trust = TRUSTED_SOURCES.has(s.source) ? " [trusted]" : "";
  return `${s.name}  ${humanInstalls(s.installs)} installs  (${s.source})${trust}  → add: ${s.id}`;
}

/** Find close matches for a skill name from installed list */
function fuzzyMatch(query: string, installed: Array<{ name: string }>): string[] {
  const q = query.toLowerCase();
  return installed
    .map((s) => ({ name: s.name, score: fuzzyScore(q, s.name.toLowerCase()) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((s) => s.name);
}

function fuzzyScore(query: string, target: string): number {
  if (target === query) return 100;
  if (target.includes(query)) return 80;
  if (query.includes(target)) return 60;
  // Token overlap
  const qTokens = new Set(query.split(/[-_\s]+/));
  const tTokens = new Set(target.split(/[-_\s]+/));
  let overlap = 0;
  for (const t of qTokens) if (tTokens.has(t)) overlap++;
  return overlap > 0 ? overlap * 20 : 0;
}

export function createSkillsTool(
  contextManager: ContextManager,
  onApprove?: (description: string) => Promise<boolean>,
) {
  return tool({
    description:
      "Search, install, load, and manage agent skills from skills.sh. " +
      "Skills are markdown instruction sets that extend your capabilities for specific domains (React, SEO, testing, etc.).\n" +
      "Actions:\n" +
      "- search: query skills.sh for available skills. Returns name, install count, source, and trust signal. " +
      "Prefer skills with high install counts (1K+) from trusted sources (vercel-labs, anthropics, microsoft, google-labs-code).\n" +
      "- list_installed: show skills installed on disk (not necessarily loaded into context).\n" +
      "- list_active: show skills currently loaded in AI context.\n" +
      "- load: load an installed skill into AI context. Requires name param.\n" +
      "- unload: remove a skill from AI context. Requires name param.\n" +
      "- install: install a skill from skills.sh. Requires id param (from search results). Optionally set global: true.",
    inputSchema: z.object({
      action: z.enum(["search", "list_installed", "list_active", "load", "unload", "install"]),
      query: z.string().nullable().optional().describe("For search: search query"),
      name: z.string().nullable().optional().describe("For load/unload: skill name"),
      id: z
        .string()
        .nullable()
        .optional()
        .describe(
          "For install: skill id from search results (e.g. 'vercel-labs/agent-skills/vercel-react-best-practices')",
        ),
      global: z
        .boolean()
        .nullable()
        .optional()
        .describe("For install: install globally (default: project)"),
    }),
    execute: async (args) => {
      try {
        switch (args.action) {
          case "search": {
            if (!args.query?.trim()) {
              // No query — show installed skills instead of failing
              const installed = listInstalledSkills();
              if (installed.length === 0) {
                return {
                  success: true,
                  output:
                    "No query provided and no skills installed. Use skills(action: search, query: 'react') to find skills.",
                };
              }
              const active = new Set(contextManager.getActiveSkills());
              const lines = installed.map(
                (s) => `${active.has(s.name) ? "● " : "  "}${s.name} (${s.scope})`,
              );
              return {
                success: true,
                output: `No query — showing installed skills (● = active):\n${lines.join("\n")}\n\nTo search: skills(action: search, query: '<topic>')`,
              };
            }
            const results = await searchSkills(args.query);
            if (results.length === 0) {
              return {
                success: true,
                output: `No skills found for "${args.query}". Try broader terms or check skills.sh directly.`,
              };
            }
            const sorted = [...results].sort((a, b) => b.installs - a.installs);
            const top = sorted.slice(0, 10);
            const lines = [
              `Skills matching "${args.query}" (${String(results.length)} total, top ${String(top.length)} by installs):`,
              "",
              ...top.map(formatSearchResult),
            ];
            if (results.length > 10) {
              lines.push(
                "",
                `... +${String(results.length - 10)} more. Narrow your search for better results.`,
              );
            }
            lines.push("", "To install: skills(action: install, id: '<id from above>')");
            lines.push(
              "After install: skills(action: load, name: '<skill name>') to activate in context.",
            );
            return { success: true, output: lines.join("\n") };
          }

          case "list_installed": {
            const installed = listInstalledSkills();
            if (installed.length === 0) {
              return {
                success: true,
                output: "No skills installed. Use skills(action: search) to find skills.",
              };
            }
            const active = new Set(contextManager.getActiveSkills());
            const lines = installed.map(
              (s) => `${active.has(s.name) ? "● " : "  "}${s.name} (${s.scope})`,
            );
            return {
              success: true,
              output: `Installed skills (● = active):\n${lines.join("\n")}`,
            };
          }

          case "list_active": {
            const active = contextManager.getActiveSkills();
            if (active.length === 0) {
              return {
                success: true,
                output: "No skills active. Use skills(action: load, name: '...') to load one.",
              };
            }
            return { success: true, output: `Active skills: ${active.join(", ")}` };
          }

          case "load": {
            if (!args.name) {
              return { success: false, output: "name required for load", error: "missing name" };
            }
            const active = contextManager.getActiveSkills();
            if (active.includes(args.name)) {
              return { success: true, output: `Skill "${args.name}" is already active.` };
            }
            const installed = listInstalledSkills();
            const exact = installed.find((s) => s.name === args.name);
            if (!exact) {
              const suggestions = fuzzyMatch(args.name, installed);
              const hint =
                suggestions.length > 0
                  ? ` Did you mean: ${suggestions.map((s) => `"${s}"`).join(", ")}?`
                  : "";
              return {
                success: false,
                output: `Skill "${args.name}" not installed.${hint} Use skills(action: search, query: '${args.name}') to find it.`,
                error: "not_found",
              };
            }
            const content = loadSkill(exact.path);
            if (!content.trim()) {
              return {
                success: false,
                output: `Skill "${args.name}" has empty content (${exact.path}).`,
                error: "empty",
              };
            }
            contextManager.addSkill(args.name, content);
            return { success: true, output: `Skill "${args.name}" loaded into context.` };
          }

          case "unload": {
            if (!args.name) {
              return { success: false, output: "name required for unload", error: "missing name" };
            }
            const active = contextManager.getActiveSkills();
            if (!active.includes(args.name)) {
              const suggestions = fuzzyMatch(
                args.name,
                active.map((n) => ({ name: n })),
              );
              const hint =
                suggestions.length > 0
                  ? ` Did you mean: ${suggestions.map((s) => `"${s}"`).join(", ")}?`
                  : "";
              return {
                success: true,
                output: `Skill "${args.name}" is not active.${hint}`,
              };
            }
            contextManager.removeSkill(args.name);
            return { success: true, output: `Skill "${args.name}" unloaded from context.` };
          }

          case "install": {
            if (!args.id) {
              return {
                success: false,
                output:
                  "id required for install (from search results, e.g. 'vercel-labs/agent-skills/vercel-react-best-practices')",
                error: "missing id",
              };
            }
            const parts = args.id.split("/");
            if (parts.length < 3) {
              return {
                success: false,
                output: `Invalid skill id "${args.id}". Expected format: owner/repo/skillId (from search results).`,
                error: "invalid_id",
              };
            }
            const skillId = parts.slice(2).join("/");
            const source = `${parts[0]}/${parts[1]}`;
            const isGlobal = args.global ?? false;

            // Require user approval before installing from the internet
            if (onApprove) {
              const approved = await onApprove(
                `Install skill "${skillId}" from ${source} (${isGlobal ? "global" : "project"})?`,
              );
              if (!approved) {
                return {
                  success: false,
                  output: `Install of "${skillId}" denied by user.`,
                  error: "denied",
                };
              }
            }

            const result = await installSkill(source, skillId, isGlobal);

            if (!result.installed) {
              return {
                success: false,
                output: `Failed to install "${skillId}" from ${source}: ${result.error ?? "unknown error"}. Try a different skill or check the source repo.`,
                error: "install_failed",
              };
            }

            // Auto-load into context
            if (result.name) {
              const installed = listInstalledSkills();
              const match = installed.find((s) => s.name === result.name);
              if (match) {
                const content = loadSkill(match.path);
                if (content.trim()) {
                  contextManager.addSkill(match.name, content);
                  return {
                    success: true,
                    output: `Skill "${match.name}" installed ${isGlobal ? "globally" : "to project"} and loaded into context.`,
                  };
                }
              }
            }
            return {
              success: true,
              output: `Skill installed ${isGlobal ? "globally" : "to project"}. Use skills(action: list_installed) to see it, then load it.`,
            };
          }

          default:
            return {
              success: false,
              output: `Unknown action: ${String(args.action)}`,
              error: "bad action",
            };
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, output: msg, error: msg };
      }
    },
  });
}
