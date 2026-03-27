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

const COMPACT_FRAMES = ["◐", "◓", "◑", "◒"];

interface BarTarget {
  pct: number;
  live: boolean;
  flash: boolean;
}

interface WorkerIndicator {
  intel: WorkerStatus;
  io: WorkerStatus;
}

function buildContent(
  pct: number,
  live: boolean,
  flash: boolean,
  compacting?: { active: boolean; frame: number },
  workers?: WorkerIndicator,
): StyledText {
  const filled = Math.round((pct / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const barColor = getBarColor(pct);
  const pulse = pct > 80;

  const pctColor = flash ? getFlashColor(pct) : getPctColor(pct);
  const chunks = [
    fgStyle(live ? "#1a6" : "#444")("● "),
    fgStyle("#333")("["),
    fgStyle(pulse ? "#b0002e" : barColor)("▰".repeat(filled)),
    fgStyle("#222")("▱".repeat(empty)),
    fgStyle("#333")("]"),
    fgStyle(pctColor)(live ? `${String(pct)}%` : `~${String(pct)}%`),
  ];
  if (compacting?.active) {
    const spinner = COMPACT_FRAMES[compacting.frame % COMPACT_FRAMES.length] ?? "◐";
    chunks.push(fgStyle("#5af")(` ${spinner} compacting`));
  }
  if (workers) {
    const worst =
      workers.intel === "crashed" || workers.io === "crashed"
        ? "crashed"
        : workers.intel === "restarting" || workers.io === "restarting"
          ? "restarting"
          : null;
    if (worst) {
      const wColor = worst === "crashed" ? "#f44" : "#FF8C00";
      const wGlyph = worst === "crashed" ? icon("worker_crash") : icon("worker_restart");
      chunks.push(fgStyle(wColor)(` ${wGlyph}`));
    }
  }
  return new StyledText(chunks);
}

interface Props {
  contextManager: ContextManager;
  modelId: string;
}

export function ContextBar({ contextManager }: Props) {
  const textRef = useRef<TextRenderable>(null);

  const targetRef = useRef<BarTarget>({ pct: 0, live: false, flash: false });
  const prevTotalRef = useRef(0);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentPctRef = useRef(0);
  const compactFrameRef = useRef(0);
  const workerRef = useRef<WorkerIndicator>({ intel: "idle", io: "idle" });
  const renderedContentRef = useRef(buildContent(0, false, false));

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

      let flash = targetRef.current.flash;
      if (totalTokens > prevTotalRef.current + 50) {
        flash = true;
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        flashTimerRef.current = setTimeout(() => {
          targetRef.current = { ...targetRef.current, flash: false };
        }, 500);
      }
      prevTotalRef.current = totalTokens;
      targetRef.current = { pct, live: isApi, flash };
    },
    [contextManager],
  );

  useEffect(() => {
    const state = useStatusBarStore.getState();
    computeTarget(state);
    currentPctRef.current = targetRef.current.pct;
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
      const isCompacting = store.compacting;
      if (isCompacting) compactFrameRef.current++;
      const pct = approach(currentPctRef.current, target.pct);
      const wk = workerRef.current;
      const wkChanged =
        wk.intel === "crashed" ||
        wk.intel === "restarting" ||
        wk.io === "crashed" ||
        wk.io === "restarting";
      if (pct === currentPctRef.current && !target.flash && !isCompacting && !wkChanged) return;
      currentPctRef.current = pct;
      try {
        const content = buildContent(
          pct,
          target.live,
          target.flash,
          isCompacting ? { active: true, frame: compactFrameRef.current } : undefined,
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
