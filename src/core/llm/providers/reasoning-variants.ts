import type { CustomReasoningConfig } from "./types.js";

export interface ThinkingVariantOption {
  value: string;
  label: string;
  description: string;
  reasoning: CustomReasoningConfig | null;
}

export const THINKING_VARIANT_OPTIONS: ThinkingVariantOption[] = [
  {
    value: "none",
    label: "None",
    description: "Explicitly disable thinking with reasoning.effort=none",
    reasoning: { effort: "none" },
  },
  {
    value: "low",
    label: "Low",
    description: "OpenAI-compatible reasoning.effort=low",
    reasoning: { effort: "low" },
  },
  {
    value: "medium",
    label: "Medium",
    description: "OpenAI-compatible reasoning.effort=medium",
    reasoning: { effort: "medium" },
  },
  {
    value: "high",
    label: "High",
    description: "OpenAI-compatible reasoning.effort=high",
    reasoning: { effort: "high" },
  },
  {
    value: "xhigh",
    label: "XHigh",
    description: "OpenAI-compatible reasoning.effort=xhigh",
    reasoning: { effort: "xhigh" },
  },
  {
    value: "budget-4096",
    label: "Budget 4096",
    description: "Fixed thinking budget with 4096 tokens",
    reasoning: { enabled: true, budget: 4096 },
  },
  {
    value: "budget-8192",
    label: "Budget 8192",
    description: "Fixed thinking budget with 8192 tokens",
    reasoning: { enabled: true, budget: 8192 },
  },
  {
    value: "budget-16384",
    label: "Budget 16384",
    description: "Fixed thinking budget with 16384 tokens",
    reasoning: { enabled: true, budget: 16384 },
  },
  {
    value: "budget-32768",
    label: "Budget 32768",
    description: "Fixed thinking budget with 32768 tokens",
    reasoning: { enabled: true, budget: 32768 },
  },
  {
    value: "inherit",
    label: "Inherit Provider Default",
    description: "Remove model override and fall back to provider.reasoning",
    reasoning: null,
  },
];

export function sameReasoning(
  a: CustomReasoningConfig | undefined,
  b: CustomReasoningConfig | undefined,
): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function getReasoningVariantLabel(
  reasoning: CustomReasoningConfig | undefined,
): string | null {
  if (!reasoning) return null;
  if (reasoning.effort) return reasoning.effort;
  if (reasoning.enabled && reasoning.budget) return `${String(reasoning.budget)} tokens`;
  if (reasoning.enabled) return "budget";
  return null;
}

export function parseBudgetInput(input: string): number | null {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[,_\s]/g, "");
  if (!normalized) return null;

  let multiplier = 1;
  let numeric = normalized;
  if (normalized.endsWith("k")) {
    multiplier = 1024;
    numeric = normalized.slice(0, -1);
  } else if (normalized.endsWith("m")) {
    multiplier = 1024 * 1024;
    numeric = normalized.slice(0, -1);
  }

  const value = Number.parseFloat(numeric);
  if (!Number.isFinite(value) || value <= 0) return null;

  const budget = Math.round(value * multiplier);
  if (budget < 256) return null;
  return budget;
}

export function getReasoningVariantValue(reasoning: CustomReasoningConfig | undefined): string {
  if (!reasoning) return "inherit";

  const matched = THINKING_VARIANT_OPTIONS.find((opt) =>
    sameReasoning(opt.reasoning ?? undefined, reasoning),
  );
  if (matched) return matched.value;

  if (reasoning.enabled && reasoning.budget) return "custom-budget";
  return "inherit";
}
