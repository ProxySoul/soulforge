import { memo, useEffect, useState } from "react";

export const POPUP_BG = "#111122";
export const POPUP_HL = "#1a1a3e";

export type ConfigScope = "project" | "global";
export const CONFIG_SCOPES: ConfigScope[] = ["project", "global"];

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const SPINNER_FRAMES_FILLED = [
  "\u28CB",
  "\u28D9",
  "\u28F9",
  "\u28F8",
  "\u28FC",
  "\u28F4",
  "\u28E6",
  "\u28E7",
  "\u28C7",
  "\u28CF",
];

let globalFrame = 0;
let refCount = 0;
let tickTimer: ReturnType<typeof setInterval> | null = null;
const frameListeners = new Set<(frame: number) => void>();

function ensureTick() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    globalFrame = (globalFrame + 1) % SPINNER_FRAMES.length;
    for (const fn of frameListeners) fn(globalFrame);
  }, 150);
}

export function useSpinnerFrame(): number {
  const [frame, setFrame] = useState(globalFrame);
  useEffect(() => {
    refCount++;
    frameListeners.add(setFrame);
    ensureTick();
    return () => {
      frameListeners.delete(setFrame);
      refCount--;
      if (refCount <= 0) {
        refCount = 0;
        if (tickTimer) {
          clearInterval(tickTimer);
          tickTimer = null;
        }
      }
    };
  }, []);
  return frame;
}

export function Spinner({
  frames = SPINNER_FRAMES,
  color = "#9B30FF",
}: {
  frames?: string[];
  color?: string;
} = {}) {
  const frame = useSpinnerFrame();
  return <text fg={color}>{frames[frame % frames.length]}</text>;
}

const OVERLAY_STYLE = { opacity: 0.65 } as const;

export function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <box position="absolute" width="100%" height="100%">
      <box
        position="absolute"
        width="100%"
        height="100%"
        backgroundColor="#0a0812"
        style={OVERLAY_STYLE}
      />
      <box
        position="absolute"
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        width="100%"
        height="100%"
      >
        {children}
      </box>
    </box>
  );
}

export const PopupRow = memo(function PopupRow({
  children,
  bg,
  w,
}: {
  children: React.ReactNode;
  bg?: string;
  w: number;
}) {
  const fill = bg ?? POPUP_BG;
  return (
    <box width={w} height={1} overflow="hidden">
      <box position="absolute">
        <text bg={fill}>{" ".repeat(w)}</text>
      </box>
      <box position="absolute" width={w} flexDirection="row">
        <text bg={fill}>{"  "}</text>
        {children}
      </box>
    </box>
  );
});
