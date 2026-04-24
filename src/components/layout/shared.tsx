import { memo, useEffect, useRef, useState } from "react";
import { useTheme, useThemeStore } from "../../core/theme/index.js";

/** Reactive popup colors — auto-update when theme changes */
export let POPUP_BG = useThemeStore.getState().tokens.bgPopup;
export let POPUP_HL = useThemeStore.getState().tokens.bgPopupHighlight;
useThemeStore.subscribe((s) => {
  POPUP_BG = s.tokens.bgPopup;
  POPUP_HL = s.tokens.bgPopupHighlight;
});
export type ConfigScope = "project" | "global";
export const CONFIG_SCOPES: ConfigScope[] = ["project", "global"];

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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

/** Returns a ref that tracks the current spinner frame WITHOUT causing re-renders.
 * Use with imperative `.content =` updates or pass to children that read `.current`. */
export function useSpinnerFrameRef(): React.RefObject<number> {
  const ref = useRef(globalFrame);
  useEffect(() => {
    const listener = (f: number) => {
      ref.current = f;
    };
    frameListeners.add(listener);
    refCount++;
    ensureTick();
    return () => {
      frameListeners.delete(listener);
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
  return ref;
}

export const Spinner = memo(function Spinner({
  frames = SPINNER_FRAMES,
  color,
  divisor = 1,
  suffix,
  bold,
  inline,
}: {
  frames?: string[];
  color?: string;
  /** Slow down frame rate — e.g. divisor=4 updates every 4th tick */
  divisor?: number;
  /** Static suffix appended after the animated frame (e.g. " " for spacing) */
  suffix?: string;
  bold?: boolean;
  /** Render as <span> for use inside <text> parents. Default: <text> for standalone use. */
  inline?: boolean;
} = {}) {
  const t = useTheme();
  // biome-ignore lint/suspicious/noExplicitAny: ref shared across text/span renderables with imperative updates
  const textRef = useRef<any>(null);
  const fg = color ?? t.brand;

  useEffect(() => {
    const isInline = !!inline;
    const listener = (f: number) => {
      try {
        if (textRef.current) {
          const idx = Math.floor(f / divisor) % frames.length;
          const val = (frames[idx] ?? "⠋") + (suffix ?? "");
          if (isInline) {
            // TextNodeRenderable (<span>) uses children, not content
            textRef.current.children = [val];
          } else {
            textRef.current.content = val;
          }
        }
      } catch {}
    };
    frameListeners.add(listener);
    refCount++;
    ensureTick();
    return () => {
      frameListeners.delete(listener);
      refCount--;
      if (refCount <= 0) {
        refCount = 0;
        if (tickTimer) {
          clearInterval(tickTimer);
          tickTimer = null;
        }
      }
    };
  }, [frames, divisor, suffix, inline]);

  const initIdx = Math.floor(globalFrame / divisor) % frames.length;
  const content = (frames[initIdx] ?? "⠋") + (suffix ?? "");
  const attrs = bold ? 1 : undefined;

  if (inline) {
    return (
      <span ref={textRef} fg={fg} attributes={attrs}>
        {content}
      </span>
    );
  }
  return (
    <text ref={textRef} fg={fg} attributes={attrs}>
      {content}
    </text>
  );
});

const OVERLAY_STYLE = { opacity: 0.65 } as const;

export function Overlay({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return (
    <box position="absolute" width="100%" height="100%">
      <box
        position="absolute"
        width="100%"
        height="100%"
        backgroundColor={t.bgOverlay}
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

// ── Popup compound component ──────────────────────────────────────────
