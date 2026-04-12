import { useEffect, useRef, useState } from "react";

const SCROLL_INTERVAL = 100;
const PAUSE_TICKS = 10;

export interface MarqueeState {
  scrollPos: number;
  startPause: number;
  endPause: number;
}

export function tickMarquee(state: MarqueeState, maxPos: number, pauseTicks: number): MarqueeState {
  if (state.endPause > 0) {
    const nextEndPause = state.endPause - 1;
    return {
      scrollPos: nextEndPause === 0 ? 0 : state.scrollPos,
      startPause: state.startPause,
      endPause: nextEndPause,
    };
  }

  if (state.scrollPos === 0 && state.startPause > 0) {
    return {
      scrollPos: 0,
      startPause: state.startPause - 1,
      endPause: 0,
    };
  }

  if (state.scrollPos >= maxPos) {
    return {
      scrollPos: state.scrollPos,
      startPause: pauseTicks,
      endPause: pauseTicks,
    };
  }

  return {
    scrollPos: state.scrollPos + 1,
    startPause: state.startPause,
    endPause: state.endPause,
  };
}

export function getMarqueeDisplayText(
  text: string,
  maxWidth: number,
  active: boolean,
  scrollPos: number,
): string {
  if (maxWidth <= 0) {
    return "";
  }
  if (active && text.length > maxWidth) {
    return text.slice(scrollPos, scrollPos + maxWidth);
  }
  if (text.length > maxWidth) {
    return `${text.slice(0, maxWidth - 1)}…`;
  }
  return text;
}

export function useMarqueeScroll(text: string, maxWidth: number, active: boolean): string {
  const [scrollPos, setScrollPos] = useState(0);
  const stateRef = useRef<MarqueeState>({ scrollPos: 0, startPause: PAUSE_TICKS, endPause: 0 });

  useEffect(() => {
    if (maxWidth <= 0) {
      stateRef.current = { scrollPos: 0, startPause: PAUSE_TICKS, endPause: 0 };
      setScrollPos(0);
      return;
    }
    if (!active || text.length <= maxWidth) {
      stateRef.current = { scrollPos: 0, startPause: PAUSE_TICKS, endPause: 0 };
      setScrollPos(0);
      return;
    }

    stateRef.current = { scrollPos: 0, startPause: PAUSE_TICKS, endPause: 0 };
    const maxPos = text.length - maxWidth;

    const timer = setInterval(() => {
      const next = tickMarquee(stateRef.current, maxPos, PAUSE_TICKS);
      stateRef.current = next;
      setScrollPos(next.scrollPos);
    }, SCROLL_INTERVAL);

    return () => clearInterval(timer);
  }, [active, text, maxWidth]);

  return getMarqueeDisplayText(text, maxWidth, active, scrollPos);
}
