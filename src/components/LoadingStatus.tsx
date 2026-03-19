import { fg as fgStyle, StyledText, type TextRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import { icon } from "../core/icons.js";
import { useStatusBarStore } from "../stores/statusbar.js";

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

function buildBusyContent(
  ghostVisible: boolean,
  isCompacting: boolean,
  forgeStatus: string,
  elapsedSec: number,
  isLoading: boolean,
  queueCount: number | undefined,
): StyledText {
  const currentGhost = ghostVisible ? ghostIcon() : " ";
  const busyStatus = isCompacting ? "Compacting context…" : forgeStatus;
  const ghostColor = isCompacting ? "#5af" : "#8B5CF6";
  const statusColor = isCompacting ? "#3388cc" : "#6A0DAD";

  const chunks = [fgStyle(ghostColor)(` ${currentGhost} `), fgStyle(statusColor)(busyStatus)];
  if ((isLoading || isCompacting) && elapsedSec > 0) {
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
  const textRef = useRef<TextRenderable>(null);
  const ghostTickRef = useRef(0);
  const forgeStatusRef = useRef("");
  const wasLoadingRef = useRef(false);
  const loadingStartRef = useRef(0);
  const completedTimeRef = useRef<string | null>(null);
  const propsRef = useRef({ isLoading, isCompacting, queueCount });
  propsRef.current = { isLoading, isCompacting, queueCount };

  const showBusy = isLoading || isCompacting;

  if (isLoading && !wasLoadingRef.current) {
    forgeStatusRef.current = FORGE_STATUSES[
      Math.floor(Math.random() * FORGE_STATUSES.length)
    ] as string;
    loadingStartRef.current = Date.now();
    completedTimeRef.current = null;
  }

  wasLoadingRef.current = isLoading;

  useEffect(() => {
    if (isLoading || !loadingStartRef.current) return;
    const finalSec = Math.floor((Date.now() - loadingStartRef.current) / 1000);
    if (finalSec > 0) {
      completedTimeRef.current = formatElapsed(finalSec);
    }
  }, [isLoading]);

  useEffect(() => {
    if (!showBusy) {
      if (completedTimeRef.current && textRef.current) {
        try {
          textRef.current.content = buildCompletedContent(completedTimeRef.current);
        } catch {}
      }
      return;
    }
    let prevGhostVisible = true;
    let prevElapsed = -1;
    let prevQc: number | undefined;
    const timer = setInterval(() => {
      ghostTickRef.current++;
      const { isLoading: ld, isCompacting: cp, queueCount: qc } = propsRef.current;
      const elapsed = cp
        ? useStatusBarStore.getState().compactElapsed
        : ld
          ? Math.floor((Date.now() - loadingStartRef.current) / 1000)
          : 0;
      const ghostVisible = ghostTickRef.current % 4 !== 3;
      if (ghostVisible === prevGhostVisible && elapsed === prevElapsed && qc === prevQc) return;
      prevGhostVisible = ghostVisible;
      prevElapsed = elapsed;
      prevQc = qc;
      try {
        if (textRef.current) {
          textRef.current.content = buildBusyContent(
            ghostVisible,
            cp,
            forgeStatusRef.current,
            elapsed,
            ld,
            qc,
          );
        }
      } catch {}
    }, GHOST_SPEED);
    return () => clearInterval(timer);
  }, [showBusy]);

  const initial = showBusy
    ? buildBusyContent(true, isCompacting, forgeStatusRef.current, 0, isLoading, queueCount)
    : completedTimeRef.current
      ? buildCompletedContent(completedTimeRef.current)
      : new StyledText([]);

  return (
    <box paddingX={0} height={1} flexDirection="row" flexShrink={0}>
      <text ref={textRef} truncate content={initial} />
    </box>
  );
}
