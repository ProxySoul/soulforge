import { tool } from "ai";
import { z } from "zod";
import type { MemoryManager } from "../memory/manager.js";
import type { MemoryCategory, MemoryScope } from "../memory/types.js";
import { MEMORY_CATEGORIES } from "../memory/types.js";

const scopeOrBothSchema = z.enum(["global", "project", "both", "all"]).describe("Memory scope");
const categorySchema = z
  .enum(MEMORY_CATEGORIES as [string, ...string[]])
  .describe("Memory category");

export function createMemoryTool(manager: MemoryManager) {
  return tool({
    description:
      "Persistent memory across sessions. Search to recall past decisions/conventions. Write ONLY when the user explicitly asks you to remember something — never proactively save.",
    inputSchema: z.object({
      action: z.enum(["write", "list", "search", "delete"]),
      scope: scopeOrBothSchema.nullable().optional().describe("Memory scope"),
      title: z
        .string()
        .nullable()
        .optional()
        .describe("For write: the memory text (auto-truncated to 120 chars)"),
      category: categorySchema.nullable().optional().describe("For write/list: category"),
      tags: z.array(z.string()).nullable().optional().describe("For write: 1-3 keyword tags"),
      id: z.string().nullable().optional().describe("For write (update) or delete: memory ID"),
      query: z.string().nullable().optional().describe("For search: search query"),
      tag: z.string().nullable().optional().describe("For list: filter by tag"),
      limit: z.number().nullable().optional().describe("For search: max results"),
    }),
    execute: async (args) => {
      try {
        switch (args.action) {
          case "write": {
            if (!args.title) {
              return { success: false, output: "title required for write", error: "missing title" };
            }
            if (!args.category) {
              return {
                success: false,
                output: "category required for write",
                error: "missing category",
              };
            }
            const resolvedScope = (args.scope as string) ?? manager.scopeConfig.writeScope;
            if (resolvedScope === "none") {
              return {
                success: false,
                output: "Memory writes are disabled (scope: none)",
                error: "disabled",
              };
            }
            const scope = resolvedScope as MemoryScope;
            const title = args.title.length > 200 ? `${args.title.slice(0, 197)}...` : args.title;
            const record = manager.write(scope, {
              title,
              category: args.category as MemoryCategory,
              tags: args.tags ?? [],
              ...(args.id ? { id: args.id } : {}),
            });
            return {
              success: true,
              output: `Saved: "${record.title}" (${record.id.slice(0, 8)}, ${scope})`,
            };
          }

          case "list": {
            const scope = (args.scope as string) ?? manager.scopeConfig.readScope;
            const results = manager.list(scope as MemoryScope | "both" | "all", {
              category: args.category as MemoryCategory | undefined,
              tag: args.tag ?? undefined,
            });
            if (results.length === 0) {
              return { success: true, output: "No memories found." };
            }
            const lines = results.map(
              (m) => `[${m.scope}] ${m.id.slice(0, 8)} | ${m.category} | ${m.title}`,
            );
            return { success: true, output: lines.join("\n") };
          }

          case "search": {
            if (!args.query) {
              return {
                success: false,
                output: "query required for search",
                error: "missing query",
              };
            }
            const scope = (args.scope as string) ?? manager.scopeConfig.readScope;
            const results = manager.search(
              args.query,
              scope as MemoryScope | "both" | "all",
              args.limit ?? undefined,
            );
            if (results.length === 0) {
              return { success: true, output: "No matching memories found." };
            }
            const lines = results.map(
              (m) => `[${m.scope}] ${m.id.slice(0, 8)} | ${m.category} | ${m.title}`,
            );
            return { success: true, output: lines.join("\n") };
          }

          case "delete": {
            if (!args.id) {
              return { success: false, output: "id required for delete", error: "missing id" };
            }
            const resolvedScope = (args.scope as string) ?? manager.scopeConfig.writeScope;
            if (resolvedScope === "none") {
              return {
                success: false,
                output: "Memory operations are disabled (scope: none)",
                error: "disabled",
              };
            }
            const scope = resolvedScope as MemoryScope;
            const deleted = manager.delete(scope, args.id);
            if (!deleted) {
              return {
                success: false,
                output: `Memory not found: ${args.id}`,
                error: "not_found",
              };
            }
            return { success: true, output: `Deleted memory ${args.id.slice(0, 8)}` };
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
