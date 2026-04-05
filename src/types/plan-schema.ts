import { z } from "zod";
import type { PlanOutput } from "./index.js";

const planSymbolChangeSchema = z.object({
  name: z.string(),
  kind: z.string(),
  action: z.enum(["add", "modify", "remove", "rename"]),
  details: z.string(),
  line: z
    .number()
    .nullable()
    .optional()
    .transform((v) => v ?? undefined),
});

const planFileChangeSchema = z.object({
  path: z.string(),
  action: z.enum(["create", "modify", "delete"]),
  description: z.string(),
  symbols: z
    .array(planSymbolChangeSchema)
    .nullable()
    .optional()
    .catch(undefined)
    .transform((v) => v ?? undefined),
});

const planOutputSchema = z.object({
  title: z.string(),
  context: z.string().catch(""),
  files: z.array(planFileChangeSchema),
  steps: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      details: z.string().optional(),
    }),
  ),
  verification: z.array(z.string()).catch([]),
});

/**
 * Safely parse raw plan data (from JSON.parse or tool args) into a validated PlanOutput.
 * Returns null if the input doesn't have the minimum required shape (title).
 */
export function parsePlanOutput(raw: unknown): PlanOutput | null {
  if (raw == null || typeof raw !== "object") return null;
  const result = planOutputSchema.safeParse(raw);
  if (!result.success) return null;
  return result.data;
}
