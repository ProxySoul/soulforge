import { memo, useEffect, useRef, useState } from "react";
import { useTheme, useThemeStore } from "../../core/theme/index.js";

/** Reactive popup colors — auto-update when theme changes */
export let POPUP_BG = useThemeStore.getState().tokens.bgPopup;
export let POPUP_HL = useThemeStore.getState().tokens.bgPopupHighlight;
useThemeStore.subscribe((s) => {
  POPUP_BG = s.tokens.bgPopup;
  POPUP_HL = s.tokens.bgPopupHighlight;
});

/** Hook for popup colors — use in React components */
export function usePopupColors() {
  const t = useTheme();
  return { bg: t.bgPopup, hl: t.bgPopupHighlight, overlay: t.bgOverlay };
}

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
export function useSpinnerFrameRef(): React.MutableRefObject<number> {
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

export const PopupRow = memo(function PopupRow({
  children,
  bg,
  w,
}: {
  children: React.ReactNode;
  bg?: string;
  w: number;
}) {
  const t = useTheme();
  const fill = bg ?? t.bgPopup;
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

/** Renders a single key hint: key in accent color + label in muted */
export function KeyHint({ keyName, label, bg }: { keyName: string; label: string; bg?: string }) {
  const t = useTheme();
  const fill = bg ?? t.bgPopup;
  return (
    <text bg={fill} fg={t.textMuted}>
      <span fg={t.brandSecondary} attributes={1 /* BOLD */}>
        {keyName}
      </span>{" "}
      {label}
    </text>
  );
}

/** Renders a footer row of key hints in MCP style: <key> label │ <key> label │ …
 *  Keys are bold + brandSecondary, labels are muted, separators are dim │.
 *  Automatically renders a full-width ─ separator above the hints. */
export function PopupFooterHints({
  hints,
  bg,
  w,
}: {
  hints: { key: string; label: string }[];
  bg?: string;
  w: number;
}) {
  const t = useTheme();
  const fill = bg ?? t.bgPopup;
  return (
    <>
      <PopupSeparator w={w} bg={bg} />
      <PopupRow w={w} bg={bg}>
        {hints.map((h, i) => (
          <text key={h.key + h.label} bg={fill}>
            {i > 0 ? <span fg={t.textFaint}>{" │ "}</span> : null}
            <span fg={t.brandSecondary} attributes={1 /* BOLD */}>
              {h.key}
            </span>
            <span fg={t.textMuted}> {h.label}</span>
          </text>
        ))}
      </PopupRow>
    </>
  );
}

/** Renders a consistent ─ separator line inside a popup */
export function PopupSeparator({ w, bg }: { w: number; bg?: string }) {
  const t = useTheme();
  const fill = bg ?? t.bgPopup;
  return (
    <PopupRow w={w} bg={bg}>
      <text bg={fill} fg={t.textFaint}>
        {"─".repeat(Math.max(0, w - 4))}
      </text>
    </PopupRow>
  );
}

// ── Popup compound component ──────────────────────────────────────────

export type HintPair = { key: string; label: string };

export interface PopupProps {
  /** Total outer width (border included). innerW = width - 2. */
  width: number;
  /** Header title text (bold, primary color). */
  title: string;
  /** Optional icon rendered before the title (brand color). */
  icon?: string;
  /** Extra content rendered after the title in the header row (e.g. status text). */
  headerRight?: React.ReactNode;
  /** Footer key hints — rendered with separator above. Omit to hide footer. */
  footer?: HintPair[];
  /** Border color override (default: brandAlt). */
  borderColor?: string;
  /** Body content — rendered between header separator and footer. */
  children: React.ReactNode;
}

/**
 * Reusable popup shell — enforces consistent structure across all modals.
 *
 * Structure:
 *   ╭─ border ──────────────────────╮
 *   │  icon  Title     headerRight  │  ← header row
 *   │  ─────────────────────────────│  ← separator
 *   │  {children}                   │  ← body (you control)
 *   │  ─────────────────────────────│  ← separator (auto from footer)
 *   │  key label │ key label │ …    │  ← footer hints
 *   ╰──────────────────────────────╯
 *
 * Usage:
 *   <Popup width={72} title="Select Model" icon={icon("model")}
 *     footer={[{ key: "↑↓", label: "nav" }, { key: "esc", label: "close" }]}>
 *     <PopupRow w={innerW}>…body…</PopupRow>
 *   </Popup>
 */
export function Popup({
  width,
  title,
  icon: ic,
  headerRight,
  footer,
  borderColor,
  children,
}: PopupProps) {
  const t = useTheme();
  const iw = width - 2;
  return (
    <Overlay>
      <box
        flexDirection="column"
        borderStyle="rounded"
        border={true}
        borderColor={borderColor ?? t.brandAlt}
        width={width}
      >
        <PopupRow w={iw}>
          {ic ? (
            <text bg={POPUP_BG} fg={t.brand} attributes={1 /* BOLD */}>
              {ic}{" "}
            </text>
          ) : null}
          <text bg={POPUP_BG} fg={t.textPrimary} attributes={1 /* BOLD */}>
            {title}
          </text>
          {headerRight ?? null}
        </PopupRow>

        <PopupSeparator w={iw} />

        {children}

        {footer && footer.length > 0 ? <PopupFooterHints w={iw} hints={footer} /> : null}
      </box>
    </Overlay>
  );
}
