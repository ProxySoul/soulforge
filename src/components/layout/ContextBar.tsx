import { fg as fgStyle, StyledText, type TextRenderable } from "@opentui/core";
import { useCallback, useEffect, useRef } from "react";
import type { ContextManager } from "../../core/context/manager.js";
import { icon } from "../../core/icons.js";
import { useStatusBarStore } from "../../stores/statusbar.js";
import { useWorkerStore, type WorkerStatus } from "../../stores/workers.js";

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
  strategy: import("../../core/compaction/types.js").CompactionStrategy;
  v2Slots: number;
}

interface WorkerIndicator {
  intel: WorkerStatus;
  io: WorkerStatus;
}

function buildContent(
  pct: number,
  tokensK: string,
  windowLabel: string,
  live: boolean,
  flash: boolean,
  compact?: CompactState,
  workers?: WorkerIndicator,
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
  } else if (compact?.strategy === "disabled") {
    chunks.push(fgStyle("#633")(" compact:off"));
  } else if (compact?.strategy === "v2") {
    chunks.push(fgStyle("#336")(` v2:${String(compact.v2Slots)}`));
  }
  if (workers) {
    const worst =
      workers.intel === "crashed" || workers.io === "crashed"
        ? "crashed"
        : workers.intel === "restarting" || workers.io === "restarting"
          ? "restarting"
          : workers.intel === "busy" || workers.io === "busy"
            ? "busy"
            : "ok";
    const wColor =
      worst === "crashed"
        ? "#f44"
        : worst === "restarting"
          ? "#FF8C00"
          : worst === "busy"
            ? "#5af"
            : "#333";
    const wGlyph =
      worst === "crashed"
        ? icon("worker_crash")
        : worst === "restarting"
          ? icon("worker_restart")
          : worst === "busy"
            ? icon("worker_busy")
            : icon("worker");
    chunks.push(fgStyle(wColor)(` ${wGlyph}`));
  }
  return new StyledText(chunks);
}

interface Props {
  contextManager: ContextManager;
  modelId: string;
}

export function ContextBar({ contextManager }: Props) {
  const textRef = useRef<TextRenderable>(null);

  const targetRef = useRef<BarTarget>({ pct: 0, tokensX10: 0, live: false, flash: false });
  const prevTotalRef = useRef(0);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentPctRef = useRef(0);
  const currentTokensRef = useRef(0);
  const compactFrameRef = useRef(0);
  const prevV2SlotsRef = useRef(0);
  const workerRef = useRef<WorkerIndicator>({ intel: "idle", io: "idle" });
  const renderedContentRef = useRef(buildContent(0, "0.0", formatWindow(200_000), false, false));

  const computeTarget = useCallback(
    (state: {
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
      targetRef.current = { pct, tokensX10, live: isApi, flash };
    },
    [contextManager],
  );

  useEffect(() => {
    const state = useStatusBarStore.getState();
    computeTarget(state);
    currentPctRef.current = targetRef.current.pct;
    currentTokensRef.current = targetRef.current.tokensX10;
    return useStatusBarStore.subscribe(computeTarget);
  }, [computeTarget]);

  useEffect(() => {
    return useWorkerStore.subscribe((state) => {
      workerRef.current = { intel: state.intelligence.status, io: state.io.status };
    });
  }, []);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current) {
        clearTimeout(flashTimerRef.current);
        flashTimerRef.current = null;
      }
    };
  }, []);

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
      const wk = workerRef.current;
      const wkChanged = wk.intel === "crashed" || wk.intel === "busy" || wk.io === "crashed";
      if (
        pct === currentPctRef.current &&
        tok === currentTokensRef.current &&
        !target.flash &&
        !isCompacting &&
        !slotsChanged &&
        !wkChanged
      )
        return;
      currentPctRef.current = pct;
      currentTokensRef.current = tok;
      try {
        const content = buildContent(
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
          wk,
        );
        renderedContentRef.current = content;
        if (textRef.current) {
          textRef.current.content = content;
        }
      } catch {}
    }, STEP_MS);
    return () => clearInterval(timer);
  }, []);

  return <text ref={textRef} truncate content={renderedContentRef.current} />;
}
