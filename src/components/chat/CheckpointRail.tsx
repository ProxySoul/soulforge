import type { ScrollBoxRenderable } from "@opentui/core";
import { memo, useEffect, useMemo, useRef } from "react";
import { useTheme } from "../../core/theme/index.js";
import type { Checkpoint } from "../../stores/checkpoints.js";
import { SPINNER_FRAMES, useSpinnerFrame } from "../layout/shared.js";

interface CheckpointRailProps {
  checkpoints: Checkpoint[];
  viewing: number | null;
  isLoading: boolean;
}

const DOT = "●";
const DOT_EMPTY = "○";
const DIAMOND = "◆";
const CONNECTOR = "│";

function getDotChar(
  cp: Checkpoint,
  isViewing: boolean,
  isLatest: boolean,
  isLive: boolean,
  spinnerFrame: number,
  t: ReturnType<typeof useTheme>,
): { char: string; color: string } {
  if (cp.status === "running")
    return {
      char: SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length] ?? "⠋",
      color: t.brandSecondary,
    };
  if (isViewing) return { char: DOT, color: t.warning };
  if (cp.undone) return { char: DOT_EMPTY, color: t.textFaint };
  // Latest active checkpoint keeps diamond shape — bright when live, muted when browsing
  if (isLatest) return { char: DIAMOND, color: isLive ? t.brand : t.textMuted };
  if (cp.filesEdited.length > 0) return { char: DOT, color: t.textMuted };
  return { char: DOT_EMPTY, color: t.textFaint };
}

const SCROLLBAR_HIDDEN = { visible: false } as const;

export const CheckpointRail = memo(function CheckpointRail({
  checkpoints,
  viewing,
}: CheckpointRailProps) {
  const t = useTheme();
  const spinnerFrame = useSpinnerFrame();
  const isLive = viewing === null;
  const showNav = checkpoints.length > 1;
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);

  const lastActiveIdx = useMemo(() => {
    for (let i = checkpoints.length - 1; i >= 0; i--) {
      if (!checkpoints[i]?.undone) return checkpoints[i]?.index ?? -1;
    }
    return -1;
  }, [checkpoints]);

  // Scroll to the focused checkpoint dot
  useEffect(() => {
    const sb = scrollRef.current;
    if (!sb) return;
    if (viewing === null) {
      // Live — scroll to bottom
      sb.scrollTo(sb.scrollHeight);
    } else {
      // Scroll the viewed checkpoint's dot into view
      sb.scrollChildIntoView(`dot-${String(viewing)}`);
    }
  }, [viewing]);

  if (checkpoints.length === 0) return null;

  return (
    <box width={3} flexGrow={1} flexShrink={0} flexDirection="column" alignItems="center">
      {showNav && <text fg={t.textMuted}>▲</text>}
      <scrollbox
        ref={scrollRef}
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        stickyScroll={isLive}
        stickyStart="bottom"
        focusable={false}
        verticalScrollbarOptions={SCROLLBAR_HIDDEN}
        horizontalScrollbarOptions={SCROLLBAR_HIDDEN}
        style={{ contentOptions: { alignItems: "center" } }}
      >
        {checkpoints.map((cp, idx) => {
          const isLatest = cp.index === lastActiveIdx;
          const style = getDotChar(cp, viewing === cp.index, isLatest, isLive, spinnerFrame, t);
          const isLast = idx === checkpoints.length - 1;
          return (
            <box
              key={`cp${String(cp.index)}`}
              id={`dot-${String(cp.index)}`}
              flexDirection="column"
              alignItems="center"
              flexShrink={0}
            >
              <text fg={style.color}>{style.char}</text>
              {!isLast && <text fg={t.textSubtle}>{CONNECTOR}</text>}
            </box>
          );
        })}
      </scrollbox>
      {showNav && <text fg={t.textMuted}>▼</text>}
    </box>
  );
});
