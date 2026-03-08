import { tool } from "ai";
import { z } from "zod";
import type { MemoryManager } from "../memory/manager.js";
import type { MemoryCategory, MemoryScope } from "../memory/types.js";
import { MEMORY_CATEGORIES } from "../memory/types.js";

const scopeSchema = z.enum(["global", "project"]).describe("Memory scope");
const scopeOrBothSchema = z.enum(["global", "project", "both", "all"]).describe("Memory scope");
const categorySchema = z
  .enum(MEMORY_CATEGORIES as [string, ...string[]])
  .describe("Memory category");

export function createMemoryTools(manager: MemoryManager) {
  const memory_write = tool({
    description:
      "Write or update a memory. Use for recording decisions, conventions, patterns, preferences, architecture notes, facts, or task checkpoints (progress snapshots for long multi-step work).",
    inputSchema: z.object({
      scope: scopeSchema.optional().describe("Memory scope (defaults to configured write scope)"),
      title: z.string().describe("Short descriptive title"),
      content: z.string().describe("Full content of the memory"),
      category: categorySchema,
      tags: z.array(z.string()).optional().describe("Tags for categorization"),
      id: z.string().optional().describe("Existing memory ID to update"),
    }),
    execute: async (args) => {
      try {
        const resolvedScope = args.scope ?? manager.scopeConfig.writeScope;
        if (resolvedScope === "none") {
          return {
            success: false,
            output: "Memory writes are disabled (scope: none)",
            error: "disabled",
          };
        }
        const scope = resolvedScope as MemoryScope;
        const record = manager.write(scope, {
          title: args.title,
          content: args.content,
          category: args.category as MemoryCategory,
          tags: args.tags ?? [],
          ...(args.id ? { id: args.id } : {}),
        });
        return {
          success: true,
          output: `Memory ${args.id ? "updated" : "created"}: "${record.title}" (${record.id.slice(0, 8)}, ${scope})`,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, output: msg, error: msg };
      }
    },
  });

  const memory_read = tool({
    description: "Read the full content of a specific memory by ID.",
    inputSchema: z.object({
      id: z.string().describe("Memory ID"),
      scope: scopeSchema
        .optional()
        .describe("Memory scope (defaults to configured read scope; tries all scopes when 'all')"),
    }),
    execute: async (args) => {
      try {
        const readScope = args.scope ?? manager.scopeConfig.readScope;
        if (readScope === "none") {
          return {
            success: false,
            output: "Memory reads are disabled (scope: none)",
            error: "disabled",
          };
        }
        const scopes: MemoryScope[] =
          readScope === "all" || (readScope as string) === "both"
            ? ["project", "global"]
            : [readScope as MemoryScope];
        let record = null;
        for (const s of scopes) {
          record = manager.read(s, args.id);
          if (record) break;
        }
        if (!record) {
          return { success: false, output: `Memory not found: ${args.id}`, error: "not_found" };
        }
        return {
          success: true,
          output: JSON.stringify(record, null, 2),
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, output: msg, error: msg };
      }
    },
  });

  const memory_list = tool({
    description: "List memories with optional filtering by scope, category, or tag.",
    inputSchema: z.object({
      scope: scopeOrBothSchema
        .optional()
        .describe("Memory scope (defaults to configured read scope)"),
      category: categorySchema.optional(),
      tag: z.string().optional().describe("Filter by tag"),
    }),
    execute: async (args) => {
      try {
        const scope = args.scope ?? manager.scopeConfig.readScope;
        const results = manager.list(scope as MemoryScope | "both" | "all", {
          category: args.category as MemoryCategory | undefined,
          tag: args.tag,
        });
        if (results.length === 0) {
          return { success: true, output: "No memories found." };
        }
        const lines = results.map((m) => `[${m.scope}] ${m.id} | ${m.category} | ${m.title}`);
        return { success: true, output: lines.join("\n") };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, output: msg, error: msg };
      }
    },
  });

  const memory_search = tool({
    description: "Full-text search across memories.",
    inputSchema: z.object({
      query: z.string().describe("Search query"),
      scope: scopeOrBothSchema
        .optional()
        .describe("Memory scope (defaults to configured read scope)"),
      limit: z.number().optional().describe("Max results (default 20)"),
    }),
    execute: async (args) => {
      try {
        const scope = args.scope ?? manager.scopeConfig.readScope;
        const results = manager.search(
          args.query,
          scope as MemoryScope | "both" | "all",
          args.limit,
        );
        if (results.length === 0) {
          return { success: true, output: "No matching memories found." };
        }
        const lines = results.map((m) => `[${m.scope}] ${m.id} | ${m.category} | ${m.title}`);
        return { success: true, output: lines.join("\n") };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, output: msg, error: msg };
      }
    },
  });

  const memory_delete = tool({
    description: "Delete a memory by ID.",
    inputSchema: z.object({
      id: z.string().describe("Memory ID to delete"),
      scope: scopeSchema.optional().describe("Memory scope (defaults to configured write scope)"),
    }),
    execute: async (args) => {
      try {
        const resolvedScope = args.scope ?? manager.scopeConfig.writeScope;
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
          return { success: false, output: `Memory not found: ${args.id}`, error: "not_found" };
        }
        return { success: true, output: `Deleted memory ${args.id.slice(0, 8)}` };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, output: msg, error: msg };
      }
    },
  });

  return { memory_write, memory_read, memory_list, memory_search, memory_delete };
}

export const MEMORY_READ_ONLY_TOOLS = ["memory_read", "memory_list", "memory_search"] as const;
export const MEMORY_ALL_TOOLS = [
  "memory_write",
  "memory_read",
  "memory_list",
  "memory_search",
  "memory_delete",
] as const;
