import { fg as fgStyle, StyledText, type TextRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import { computeCost, useStatusBarStore } from "../../stores/statusbar.js";

const STEP_MS = 50;
const EASE = 0.35;

function approach(current: number, target: number): number {
  if (current === target) return target;
  const next = current + (target - current) * EASE;
  return Math.abs(next - target) < 1 ? target : Math.round(next);
}

function fmtCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function buildContent(costCents: number, cacheHitPct: number): StyledText {
  const cost = costCents / 100;
  if (cost <= 0) return new StyledText([fgStyle("#333")("$0")]);
  const color = cacheHitPct > 50 ? "#1a6" : "#999";
  return new StyledText([fgStyle(color)(fmtCost(cost))]);
}

export function TokenDisplay() {
  const textRef = useRef<TextRenderable>(null);

  const costRef = useRef(0);
  const cacheHitRef = useRef(0);
  const currentCostRef = useRef(0);

  useEffect(
    () =>
      useStatusBarStore.subscribe((state) => {
        const usage = state.tokenUsage;
        const rawCost = computeCost(usage, state.activeModel);
        costRef.current = Math.round(rawCost * 100);
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
          textRef.current.content = buildContent(currentCostRef.current, cacheHitRef.current);
      } catch {}
    }, STEP_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <text
      ref={textRef}
      truncate
      content={buildContent(currentCostRef.current, cacheHitRef.current)}
    />
  );
}
