import { fg as fgStyle, StyledText, type TextRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import { computeCost, type TokenUsage, useStatusBarStore } from "../../stores/statusbar.js";

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const STEP_MS = 50;
const EASE = 0.35;

function approach(current: number, target: number): number {
  if (current === target) return target;
  const next = current + (target - current) * EASE;
  return Math.abs(next - target) < 1 ? target : Math.round(next);
}

function approachUsage(current: TokenUsage, target: TokenUsage): TokenUsage {
  return {
    prompt: approach(current.prompt, target.prompt),
    completion: approach(current.completion, target.completion),
    total: approach(current.total, target.total),
    cacheRead: approach(current.cacheRead, target.cacheRead),
    cacheWrite: approach(current.cacheWrite, target.cacheWrite),
    subagentInput: approach(current.subagentInput, target.subagentInput),
    subagentOutput: approach(current.subagentOutput, target.subagentOutput),
    lastStepInput: target.lastStepInput,
    lastStepOutput: target.lastStepOutput,
    lastStepCacheRead: target.lastStepCacheRead,
  };
}

function usageEqual(a: TokenUsage, b: TokenUsage): boolean {
  return (
    a.prompt === b.prompt &&
    a.completion === b.completion &&
    a.cacheRead === b.cacheRead &&
    a.subagentInput === b.subagentInput &&
    a.subagentOutput === b.subagentOutput &&
    a.lastStepInput === b.lastStepInput
  );
}

const CACHE_BAR_W = 6;

function fmtCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function buildContent(u: TokenUsage, modelId: string): StyledText {
  const freshInput = u.prompt + u.subagentInput;
  const totalOutput = u.completion + u.subagentOutput;
  const chunks = [
    fgStyle("#2d9bf0")(fmt(freshInput)),
    fgStyle("#444")("↑ "),
    fgStyle("#e0a020")(fmt(totalOutput)),
    fgStyle("#444")("↓"),
  ];
  if (u.cacheRead > 0 || u.cacheWrite > 0) {
    const totalInput = freshInput + u.cacheRead + u.cacheWrite;
    const cachePct =
      totalInput > 0 ? Math.min(100, Math.round((u.cacheRead / totalInput) * 100)) : 0;
    const filled = Math.round((cachePct / 100) * CACHE_BAR_W);
    chunks.push(
      fgStyle("#444")(" ["),
      fgStyle("#2d5")("▰".repeat(filled)),
      fgStyle("#222")("▱".repeat(CACHE_BAR_W - filled)),
      fgStyle("#444")("]"),
      fgStyle("#2d5")(` ${fmt(u.cacheRead)} cached`),
    );
  }
  const sub = u.subagentInput + u.subagentOutput;
  if (sub > 0) {
    chunks.push(fgStyle("#9B30FF")(` ∂${fmt(sub)}`));
  }
  const cost = computeCost(u, modelId);
  if (cost > 0) {
    chunks.push(fgStyle("#444")(" "), fgStyle("#ccc")(fmtCost(cost)));
  }
  if (u.lastStepInput > 0 || u.lastStepCacheRead > 0) {
    chunks.push(
      fgStyle("#444")(" step:"),
      fgStyle("#68a")(fmt(u.lastStepInput)),
      fgStyle("#444")("↑"),
    );
    if (u.lastStepCacheRead > 0) {
      chunks.push(fgStyle("#2d5")(` ${fmt(u.lastStepCacheRead)}c`));
    }
  }
  return new StyledText(chunks);
}

export function TokenDisplay() {
  const textRef = useRef<TextRenderable>(null);

  // Transient: catch state-changes in a reference, no re-render
  const targetRef = useRef(useStatusBarStore.getState().tokenUsage);
  const modelRef = useRef(useStatusBarStore.getState().activeModel);
  useEffect(
    () =>
      useStatusBarStore.subscribe((state) => {
        targetRef.current = state.tokenUsage;
        modelRef.current = state.activeModel;
      }),
    [],
  );

  // Animation loop: lerp current → target, update renderable directly
  const currentRef = useRef<TokenUsage>({ ...targetRef.current });
  useEffect(() => {
    const timer = setInterval(() => {
      const target = targetRef.current;
      if (usageEqual(currentRef.current, target)) return;
      currentRef.current = approachUsage(currentRef.current, target);
      try {
        if (textRef.current)
          textRef.current.content = buildContent(currentRef.current, modelRef.current);
      } catch {}
    }, STEP_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <text ref={textRef} truncate content={buildContent(currentRef.current, modelRef.current)} />
  );
}
