import { fg as fgStyle, StyledText, type TextRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import type { ContextManager } from "../core/context/manager.js";
import { useStatusBarStore } from "../stores/statusbar.js";

const BAR_WIDTH = 8;
const CHARS_PER_TOKEN = 4;
const STEP_MS = 50;
const EASE = 0.35;

function approach(current: number, target: number): number {
  if (current === target) return target;
  const next = current + (target - current) * EASE;
  return Math.abs(next - target) < 1 ? target : Math.round(next);
}

function getBarColor(pct: number): string {
  if (pct < 50) return "#1a6";
  if (pct < 70) return "#a07018";
  if (pct < 85) return "#b06000";
  return "#b0002e";
}

function getPctColor(pct: number): string {
  if (pct < 50) return "#176";
  if (pct < 70) return "#7a5510";
  if (pct < 85) return "#884a00";
  return "#881020";
}

function getFlashColor(pct: number): string {
  if (pct < 50) return "#1a6";
  if (pct < 70) return "#a07018";
  if (pct < 85) return "#b06000";
  return "#b0002e";
}

function formatWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k`;
  return String(tokens);
}

interface BarTarget {
  pct: number;
  tokensX10: number;
  live: boolean;
  flash: boolean;
}

const COMPACT_FRAMES = ["◐", "◓", "◑", "◒"];

interface CompactState {
  active: boolean;
  frame: number;
  strategy: "v1" | "v2";
  v2Slots: number;
}

function buildContent(
  pct: number,
  tokensK: string,
  windowLabel: string,
  live: boolean,
  flash: boolean,
  compact?: CompactState,
): StyledText {
  const filled = Math.round((pct / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const barColor = getBarColor(pct);
  const pulse = pct > 80;

  const pctColor = flash ? getFlashColor(pct) : getPctColor(pct);
  const chunks = [
    fgStyle(live ? "#1a6" : "#444")("● "),
    fgStyle("#444")("ctx"),
    fgStyle("#333")("["),
    fgStyle(pulse ? "#b0002e" : barColor)("▰".repeat(filled)),
    fgStyle("#222")("▱".repeat(empty)),
    fgStyle("#333")("]"),
    fgStyle(pctColor)(live ? `${String(pct)}%` : `~${String(pct)}%`),
    fgStyle("#444")(` ${tokensK}k/${windowLabel}`),
  ];
  if (compact?.active) {
    const spinner = COMPACT_FRAMES[compact.frame % COMPACT_FRAMES.length] ?? "◐";
    chunks.push(fgStyle("#5af")(` ${spinner} compacting`));
  } else if (compact?.strategy === "v2") {
    chunks.push(fgStyle("#336")(` v2:${String(compact.v2Slots)}`));
  }
  return new StyledText(chunks);
}

interface Props {
  contextManager: ContextManager;
  modelId: string;
}

export function ContextBar({ contextManager }: Props) {
  const textRef = useRef<TextRenderable>(null);

  const initStore = useStatusBarStore.getState();
  const initCtxTokens = initStore.contextTokens;
  const initCtxWindow = initStore.contextWindow || 200_000;
  const initPct = initCtxTokens > 0
    ? Math.min(100, Math.max(1, Math.round((initCtxTokens / initCtxWindow) * 100)))
    : 0;

  const targetRef = useRef<BarTarget>({
    pct: initPct,
    tokensX10: Math.round(initCtxTokens / 100),
    live: initCtxTokens > 0,
    flash: false,
  });
  const prevTotalRef = useRef(0);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const update = (state: {
      contextTokens: number;
      contextWindow: number;
      chatChars: number;
      subagentChars: number;
    }) => {
      const ctxWindow = state.contextWindow || 200_000;
      const isApi = state.contextTokens > 0;
      const breakdown = contextManager.getContextBreakdown();
      const systemChars = breakdown.reduce((sum, s) => sum + s.chars, 0);
      const charEstimate = (systemChars + state.chatChars + state.subagentChars) / CHARS_PER_TOKEN;
      const totalTokens = isApi
        ? state.contextTokens + state.subagentChars / CHARS_PER_TOKEN
        : charEstimate;
      const live = isApi;
      const rawPct = (totalTokens / ctxWindow) * 100;
      const pct = totalTokens > 0 ? Math.min(100, Math.max(1, Math.round(rawPct))) : 0;
      const tokensX10 = Math.round(totalTokens / 100);

      let flash = targetRef.current.flash;
      if (totalTokens > prevTotalRef.current + 50) {
        flash = true;
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        flashTimerRef.current = setTimeout(() => {
          targetRef.current = { ...targetRef.current, flash: false };
        }, 500);
      }
      prevTotalRef.current = totalTokens;

      targetRef.current = { pct, tokensX10, live, flash };
    };
    // Fire immediately so the bar reflects current state (subscribe alone only fires on change)
    update(useStatusBarStore.getState());
    return useStatusBarStore.subscribe(update);
  }, [contextManager]);

  const currentPctRef = useRef(initPct);
  const currentTokensRef = useRef(Math.round(initCtxTokens / 100));
  const compactFrameRef = useRef(0);
  const prevV2SlotsRef = useRef(0);
  useEffect(() => {
    const timer = setInterval(() => {
      const target = targetRef.current;
      const store = useStatusBarStore.getState();
      const winLabel = formatWindow(store.contextWindow || 200_000);
      const isCompacting = store.compacting;
      if (isCompacting) compactFrameRef.current++;
      const pct = approach(currentPctRef.current, target.pct);
      const tok = approach(currentTokensRef.current, target.tokensX10);
      const slotsChanged = store.v2Slots !== prevV2SlotsRef.current;
      prevV2SlotsRef.current = store.v2Slots;
      if (
        pct === currentPctRef.current &&
        tok === currentTokensRef.current &&
        !target.flash &&
        !isCompacting &&
        !slotsChanged
      )
        return;
      currentPctRef.current = pct;
      currentTokensRef.current = tok;
      try {
        if (textRef.current) {
          textRef.current.content = buildContent(
            pct,
            (tok / 10).toFixed(1),
            winLabel,
            target.live,
            target.flash,
            {
              active: isCompacting,
              frame: compactFrameRef.current,
              strategy: store.compactionStrategy,
              v2Slots: store.v2Slots,
            },
          );
        }
      } catch {}
    }, STEP_MS);
    return () => clearInterval(timer);
  }, []);

  const initial = buildContent(initPct, (initCtxTokens / 1000).toFixed(1), formatWindow(initCtxWindow), initCtxTokens > 0, false);
  return <text ref={textRef} truncate content={initial} />;
}
