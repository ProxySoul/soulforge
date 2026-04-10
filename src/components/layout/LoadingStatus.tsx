import { fg as fgStyle, StyledText, type TextRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import { getThemeTokens } from "../../core/theme/index.js";
import { formatElapsed } from "../../hooks/useElapsed.js";
import { useStatusBarStore } from "../../stores/statusbar.js";
import { FORGE_TICK_MS, forgeSpinnerChunks } from "./ForgeSpinner.js";

const FORGE_STATUSES = [
  "Forging response",
  "Stoking the flames",
  "Summoning spirits",
  "Channeling the ether",
  "Tempering thoughts",
  "Conjuring words",
  "Consulting the runes",
  "Weaving spellwork",
  "Kindling the forge",
  "Gathering arcana",
];

const DOTS_CYCLE = [".", "..", "...", "..", ".", ".."];
const DOTS_SPEED = 4;

// ── Color interpolation for breathing effect ────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.substring(0, 2), 16) || 0,
    parseInt(h.substring(2, 4), 16) || 0,
    parseInt(h.substring(4, 6), 16) || 0,
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

function lerpColor(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex(
    Math.round(ar + (br - ar) * t),
    Math.round(ag + (bg - ag) * t),
    Math.round(ab + (bb - ab) * t),
  );
}

const BREATH_PERIOD = 20;

function breathe(tick: number): number {
  return (Math.sin((tick / BREATH_PERIOD) * Math.PI * 2 - Math.PI / 2) + 1) / 2;
}

// ── Build single-line StyledText content ─────────────────────────────

function buildBusyLine(
  spinnerFrame: number,
  isCompacting: boolean,
  forgeStatus: string,
  elapsedSec: number,
): StyledText {
  const tk = getThemeTokens();
  const baseColor = isCompacting ? tk.info : tk.brand;
  const statusText = isCompacting ? "Compacting context" : forgeStatus;
  const dots = DOTS_CYCLE[Math.floor(spinnerFrame / DOTS_SPEED) % DOTS_CYCLE.length] ?? ".";

  const t = breathe(spinnerFrame);
  const textColor = lerpColor(tk.textMuted, baseColor, t);

  const runeChunks = forgeSpinnerChunks(
    spinnerFrame,
    tk.brand,
    tk.textMuted,
    tk.textFaint,
    tk.warning,
  );

  const parts: ReturnType<ReturnType<typeof fgStyle>>[] = [
    fgStyle(tk.textFaint)(" "),
    ...runeChunks,
    fgStyle(tk.textFaint)(" "),
    fgStyle(textColor)(statusText),
    fgStyle(tk.textFaint)(`${dots.padEnd(3)}`),
  ];
  if (elapsedSec > 0) {
    parts.push(fgStyle(tk.textFaint)(` ${formatElapsed(elapsedSec)}`));
  }
  parts.push(fgStyle(tk.textFaint)("  "));
  return new StyledText(parts);
}

interface LoadingStatusProps {
  isLoading: boolean;
  isCompacting: boolean;
  loadingStartedAt?: number;
}

export function LoadingStatus({ isLoading, isCompacting, loadingStartedAt }: LoadingStatusProps) {
  const textRef = useRef<TextRenderable>(null);
  const forgeStatusRef = useRef("");
  const wasLoadingRef = useRef(false);
  const loadingStartRef = useRef(0);
  const elapsedSecRef = useRef(0);
  const spinnerTickRef = useRef(0);
  const propsRef = useRef({ isLoading, isCompacting });
  propsRef.current = { isLoading, isCompacting };

  const showBusy = isLoading || isCompacting;

  if (isLoading && !wasLoadingRef.current) {
    forgeStatusRef.current = FORGE_STATUSES[
      Math.floor(Math.random() * FORGE_STATUSES.length)
    ] as string;
    loadingStartRef.current = loadingStartedAt || Date.now();
    elapsedSecRef.current = 0;
  }

  wasLoadingRef.current = isLoading;

  useEffect(() => {
    if (!showBusy) return;
    const timer = setInterval(() => {
      spinnerTickRef.current++;
      const { isLoading: ld, isCompacting: cp } = propsRef.current;
      const elapsed = cp
        ? useStatusBarStore.getState().compactElapsed
        : ld
          ? Math.floor((Date.now() - loadingStartRef.current) / 1000)
          : 0;
      elapsedSecRef.current = elapsed;
      try {
        if (textRef.current) {
          textRef.current.content = buildBusyLine(
            spinnerTickRef.current,
            cp,
            forgeStatusRef.current,
            elapsed,
          );
        }
      } catch {}
    }, FORGE_TICK_MS);
    return () => clearInterval(timer);
  }, [showBusy]);

  if (!showBusy) return null;

  return (
    <box height={1} flexShrink={0}>
      <text
        ref={textRef}
        content={buildBusyLine(
          spinnerTickRef.current,
          isCompacting,
          forgeStatusRef.current,
          elapsedSecRef.current,
        )}
      />
    </box>
  );
}
