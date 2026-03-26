import { fg as fgStyle, StyledText, type TextRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef } from "react";
import { icon } from "../../core/icons.js";
import { useStatusBarStore } from "../../stores/statusbar.js";

const PURPLE_GLOW = "#BF5FFF";
const PURPLE = "#9B30FF";
const PURPLE_DIM = "#6B20B0";
const SCAN_FAINT = "#1a1a2e";
const SCAN_SPEED = 120;

function buildScanContent(pos: number, width: number): StyledText {
  const segments: ReturnType<ReturnType<typeof fgStyle>>[] = [];
  for (let i = 0; i < width; i++) {
    const dist = Math.abs(i - pos);
    const color =
      dist === 0 ? PURPLE_GLOW : dist === 1 ? PURPLE : dist === 2 ? PURPLE_DIM : SCAN_FAINT;
    const ch = dist === 0 ? "━" : "─";
    segments.push(fgStyle(color)(ch));
  }
  return new StyledText(segments);
}

const FORGE_STATUSES = [
  "Forging response…",
  "Stoking the flames…",
  "Summoning spirits…",
  "Channeling the ether…",
  "Tempering thoughts…",
  "Conjuring words…",
  "Consulting the runes…",
  "Weaving spellwork…",
  "Kindling the forge…",
  "Gathering arcana…",
];

const ghostIcon = () => icon("ghost");
const GHOST_SPEED = 400;

function formatElapsed(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${String(h)}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
  if (m > 0) return `${String(m)}m ${String(s).padStart(2, "0")}s`;
  return `${String(s)}s`;
}

function buildGhostContent(ghostVisible: boolean, isCompacting: boolean): StyledText {
  const currentGhost = ghostVisible ? ghostIcon() : " ";
  const ghostColor = isCompacting ? "#5af" : "#8B5CF6";
  return new StyledText([fgStyle(ghostColor)(` ${currentGhost} `)]);
}

function buildStatusContent(isCompacting: boolean, forgeStatus: string): StyledText {
  const busyStatus = isCompacting ? "Compacting context…" : forgeStatus;
  const statusColor = isCompacting ? "#3388cc" : "#6A0DAD";
  return new StyledText([fgStyle(statusColor)(busyStatus)]);
}

function buildElapsedContent(elapsedSec: number, queueCount: number | undefined): StyledText {
  const chunks: ReturnType<ReturnType<typeof fgStyle>>[] = [];
  if (elapsedSec > 0) {
    chunks.push(fgStyle("#555")(` ${formatElapsed(elapsedSec)}`));
  }
  if (queueCount != null && queueCount > 0) {
    chunks.push(fgStyle("#555")(` (${String(queueCount)} queued)`));
  }
  return new StyledText(chunks);
}

function buildCompletedContent(time: string): StyledText {
  return new StyledText([fgStyle("#2a5")(" ✓ "), fgStyle("#555")(`Completed in ${time}`)]);
}

interface LoadingStatusProps {
  isLoading: boolean;
  isCompacting: boolean;
  queueCount?: number;
}

export function LoadingStatus({ isLoading, isCompacting, queueCount }: LoadingStatusProps) {
  const { width: termWidth } = useTerminalDimensions();
  const ghostRef = useRef<TextRenderable>(null);
  const statusRef = useRef<TextRenderable>(null);
  const elapsedRef = useRef<TextRenderable>(null);
  const completedRef = useRef<TextRenderable>(null);
  const scanRef = useRef<TextRenderable>(null);
  const ghostTickRef = useRef(0);
  const forgeStatusRef = useRef("");
  const wasLoadingRef = useRef(false);
  const loadingStartRef = useRef(0);
  const completedTimeRef = useRef<string | null>(null);
  const elapsedSecRef = useRef(0);
  const scanPosRef = useRef(0);
  const propsRef = useRef({ isLoading, isCompacting, queueCount });
  propsRef.current = { isLoading, isCompacting, queueCount };
  const scanWidth = Math.max(10, (termWidth ?? 80) - 4);

  const showBusy = isLoading || isCompacting;

  if (isLoading && !wasLoadingRef.current) {
    forgeStatusRef.current = FORGE_STATUSES[
      Math.floor(Math.random() * FORGE_STATUSES.length)
    ] as string;
    loadingStartRef.current = Date.now();
    elapsedSecRef.current = 0;
    completedTimeRef.current = null;
  }

  // Compute completed time synchronously during render (not in useEffect)
  // so the "Completed in Xs" message appears immediately when loading stops.
  if (!isLoading && wasLoadingRef.current && loadingStartRef.current) {
    const finalSec = Math.floor((Date.now() - loadingStartRef.current) / 1000);
    completedTimeRef.current = finalSec > 0 ? formatElapsed(finalSec) : "<1s";
  }

  wasLoadingRef.current = isLoading;

  // Ghost animation — fast interval, only touches ghostRef
  useEffect(() => {
    if (!showBusy) return;
    const timer = setInterval(() => {
      ghostTickRef.current++;
      const { isCompacting: cp } = propsRef.current;
      const ghostVisible = ghostTickRef.current % 4 !== 3;
      try {
        if (ghostRef.current) {
          ghostRef.current.content = buildGhostContent(ghostVisible, cp);
        }
      } catch {}
    }, GHOST_SPEED);
    return () => clearInterval(timer);
  }, [showBusy]);

  // Scan line animation — fast interval, only touches scanRef
  useEffect(() => {
    if (!showBusy) {
      scanPosRef.current = 0;
      return;
    }
    const w = scanWidth;
    const timer = setInterval(() => {
      scanPosRef.current = (scanPosRef.current + 1) % (w + 6);
      try {
        if (scanRef.current) {
          scanRef.current.content = buildScanContent(scanPosRef.current, w);
        }
      } catch {}
    }, SCAN_SPEED);
    return () => clearInterval(timer);
  }, [showBusy, scanWidth]);

  // Elapsed timer — 1s interval, only touches elapsedRef
  useEffect(() => {
    if (!showBusy) {
      if (completedTimeRef.current && completedRef.current) {
        try {
          completedRef.current.content = buildCompletedContent(completedTimeRef.current);
        } catch {}
      }
      return;
    }
    let prevElapsed = -1;
    let prevQc: number | undefined;
    const timer = setInterval(() => {
      const { isLoading: ld, isCompacting: cp, queueCount: qc } = propsRef.current;
      const elapsed = cp
        ? useStatusBarStore.getState().compactElapsed
        : ld
          ? Math.floor((Date.now() - loadingStartRef.current) / 1000)
          : 0;
      if (elapsed === prevElapsed && qc === prevQc) return;
      prevElapsed = elapsed;
      prevQc = qc;
      elapsedSecRef.current = elapsed;
      try {
        if (elapsedRef.current) {
          elapsedRef.current.content = buildElapsedContent(elapsed, qc);
        }
      } catch {}
    }, 1000);
    return () => clearInterval(timer);
  }, [showBusy]);

  return (
    <box paddingX={0} flexDirection="column" flexShrink={0}>
      {showBusy && (
        <box height={1} paddingX={1}>
          <text ref={scanRef} content={buildScanContent(scanPosRef.current, scanWidth)} />
        </box>
      )}
      <box height={1} flexDirection="row">
        {showBusy ? (
          <>
            <text
              ref={ghostRef}
              content={buildGhostContent(ghostTickRef.current % 4 !== 3, isCompacting)}
            />
            <text
              ref={statusRef}
              content={buildStatusContent(isCompacting, forgeStatusRef.current)}
            />
            <text
              ref={elapsedRef}
              truncate
              content={buildElapsedContent(elapsedSecRef.current, queueCount)}
            />
          </>
        ) : completedTimeRef.current ? (
          <text
            ref={completedRef}
            truncate
            content={buildCompletedContent(completedTimeRef.current)}
          />
        ) : null}
      </box>
    </box>
  );
}
