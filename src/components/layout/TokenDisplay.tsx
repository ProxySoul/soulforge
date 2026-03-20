import { fg as fgStyle, StyledText, type TextRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import type { TokenUsage } from "../../stores/statusbar.js";
import { useStatusBarStore } from "../../stores/statusbar.js";

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
    subagentInput: approach(current.subagentInput, target.subagentInput),
    subagentOutput: approach(current.subagentOutput, target.subagentOutput),
  };
}

function usageEqual(a: TokenUsage, b: TokenUsage): boolean {
  return (
    a.prompt === b.prompt &&
    a.completion === b.completion &&
    a.cacheRead === b.cacheRead &&
    a.subagentInput === b.subagentInput &&
    a.subagentOutput === b.subagentOutput
  );
}

function buildContent(u: TokenUsage): StyledText {
  const uncachedInput = Math.max(0, u.prompt - u.cacheRead);
  const chunks = [
    fgStyle("#2d9bf0")(fmt(uncachedInput)),
    fgStyle("#444")("↑ "),
    fgStyle("#e0a020")(fmt(u.completion)),
    fgStyle("#444")("↓ "),
  ];
  if (u.cacheRead > 0) {
    chunks.push(fgStyle("#4a7")(` ${fmt(u.cacheRead)} cached`));
  }
  const sub = u.subagentInput + u.subagentOutput;
  if (sub > 0) {
    chunks.push(fgStyle("#9B30FF")(` ∂${fmt(sub)}`));
  }
  return new StyledText(chunks);
}

export function TokenDisplay() {
  const textRef = useRef<TextRenderable>(null);

  // Transient: catch state-changes in a reference, no re-render
  const targetRef = useRef(useStatusBarStore.getState().tokenUsage);
  useEffect(
    () => useStatusBarStore.subscribe((state) => (targetRef.current = state.tokenUsage)),
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
        if (textRef.current) textRef.current.content = buildContent(currentRef.current);
      } catch {}
    }, STEP_MS);
    return () => clearInterval(timer);
  }, []);

  return <text ref={textRef} truncate content={buildContent(currentRef.current)} />;
}
