import { fg as fgStyle, StyledText, type TextRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import { getThemeTokens } from "../../core/theme/index.js";
import {
  computeTotalCostFromBreakdown,
  isModelFree,
  isModelLocal,
  useStatusBarStore,
} from "../../stores/statusbar.js";

const STEP_MS = 50;
const EASE = 0.35;

function approach(current: number, target: number): number {
  if (current === target) return target;
  const next = current + (target - current) * EASE;
  return Math.abs(next - target) < 1 ? target : Math.round(next);
}

function fmtCost(usd: number): string {
  if (!Number.isFinite(usd)) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function buildContent(
  costCents: number,
  cacheHitPct: number,
  free: boolean,
  local: boolean,
): StyledText {
  const tk = getThemeTokens();
  if (local) return new StyledText([fgStyle(tk.success)("Local")]);
  if (free) return new StyledText([fgStyle(tk.success)("FREE")]);
  const cost = costCents / 100;
  if (cost <= 0) return new StyledText([fgStyle(tk.textFaint)("$0")]);
  const color = cacheHitPct > 50 ? tk.success : tk.textSecondary;
  return new StyledText([fgStyle(color)(fmtCost(cost))]);
}

export function TokenDisplay() {
  const textRef = useRef<TextRenderable>(null);

  const costRef = useRef(0);
  const cacheHitRef = useRef(0);
  const currentCostRef = useRef(0);
  const freeRef = useRef(false);
  const localRef = useRef(false);

  useEffect(
    () =>
      useStatusBarStore.subscribe((state) => {
        const usage = state.tokenUsage;
        const breakdown = usage.modelBreakdown;
        // Check if ALL models in the breakdown are local or free
        const modelIds = Object.keys(breakdown);
        localRef.current = modelIds.length > 0 && modelIds.every((mid) => isModelLocal(mid));
        freeRef.current =
          !localRef.current && modelIds.length > 0 && modelIds.every((mid) => isModelFree(mid));
        const rawCost =
          breakdown && modelIds.length > 0 ? computeTotalCostFromBreakdown(breakdown) : 0;
        costRef.current = Number.isFinite(rawCost) ? Math.round(rawCost * 100) : 0;
        const totalInput = usage.prompt + usage.subagentInput + usage.cacheRead + usage.cacheWrite;
        cacheHitRef.current = totalInput > 0 ? Math.round((usage.cacheRead / totalInput) * 100) : 0;
      }),
    [],
  );

  useEffect(() => {
    const timer = setInterval(() => {
      const target = costRef.current;
      if (currentCostRef.current === target) return;
      currentCostRef.current = approach(currentCostRef.current, target);
      try {
        if (textRef.current)
          textRef.current.content = buildContent(
            currentCostRef.current,
            cacheHitRef.current,
            freeRef.current,
            localRef.current,
          );
      } catch {}
    }, STEP_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <text
      ref={textRef}
      truncate
      content={buildContent(
        currentCostRef.current,
        cacheHitRef.current,
        freeRef.current,
        localRef.current,
      )}
    />
  );
}
