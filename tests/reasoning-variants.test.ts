import { describe, expect, test } from "bun:test";
import {
  getReasoningVariantValue,
  getReasoningVariantLabel,
  parseBudgetInput,
  THINKING_VARIANT_OPTIONS,
} from "../src/core/llm/providers/reasoning-variants.js";

describe("reasoning variants", () => {
  test("preset budget variants use higher token milestones", () => {
    const budgetValues = THINKING_VARIANT_OPTIONS.filter((opt) => opt.reasoning?.budget).map(
      (opt) => opt.reasoning?.budget,
    );
    expect(budgetValues).toEqual([4096, 8192, 16384, 32768]);
  });

  test("parseBudgetInput accepts raw token counts", () => {
    expect(parseBudgetInput("4096")).toBe(4096);
    expect(parseBudgetInput("16384")).toBe(16384);
  });

  test("parseBudgetInput accepts shorthand suffixes", () => {
    expect(parseBudgetInput("4k")).toBe(4096);
    expect(parseBudgetInput("16k")).toBe(16384);
    expect(parseBudgetInput("32k")).toBe(32768);
  });

  test("parseBudgetInput ignores spacing and separators", () => {
    expect(parseBudgetInput(" 8,192 ")).toBe(8192);
    expect(parseBudgetInput("8_192")).toBe(8192);
  });

  test("parseBudgetInput rejects invalid or too-small values", () => {
    expect(parseBudgetInput("")).toBeNull();
    expect(parseBudgetInput("abc")).toBeNull();
    expect(parseBudgetInput("128")).toBeNull();
    expect(parseBudgetInput("0")).toBeNull();
  });

  test("getReasoningVariantLabel renders budget shorthand", () => {
    expect(getReasoningVariantLabel({ effort: "high" })).toBe("high");
    expect(getReasoningVariantLabel({ effort: "xhigh" })).toBe("xhigh");
    expect(getReasoningVariantLabel({ enabled: true, budget: 4096 })).toBe("4096 tokens");
    expect(getReasoningVariantLabel({ enabled: true })).toBe("budget");
    expect(getReasoningVariantLabel(undefined)).toBeNull();
  });

  test("getReasoningVariantValue maps unknown budgets to custom-budget", () => {
    expect(getReasoningVariantValue({ enabled: true, budget: 24576 })).toBe("custom-budget");
    expect(getReasoningVariantValue({ enabled: true, budget: 16384 })).toBe("budget-16384");
    expect(getReasoningVariantValue({ effort: "medium" })).toBe("medium");
    expect(getReasoningVariantValue(undefined)).toBe("inherit");
  });
});
