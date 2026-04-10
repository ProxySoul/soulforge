import { useEffect, useRef, useState } from "react";

const SCROLL_INTERVAL = 100;
const PAUSE_TICKS = 10;

export function useMarqueeScroll(text: string, maxWidth: number, active: boolean): string {
  const [scrollPos, setScrollPos] = useState(0);
  const pauseRef = useRef(PAUSE_TICKS);

  useEffect(() => {
    if (!active || maxWidth <= 0 || text.length <= maxWidth) {
      setScrollPos(0);
      return;
    }

    pauseRef.current = PAUSE_TICKS;
    const maxPos = text.length - maxWidth;
    let endPause = 0;

    const timer = setInterval(() => {
      if (endPause > 0) {
        endPause--;
        if (endPause === 0) setScrollPos(0);
        return;
      }
      setScrollPos((prev) => {
        if (prev === 0 && pauseRef.current > 0) {
          pauseRef.current--;
          return 0;
        }
        if (prev >= maxPos) {
          pauseRef.current = PAUSE_TICKS;
          endPause = PAUSE_TICKS;
          return prev;
        }
        return prev + 1;
      });
    }, SCROLL_INTERVAL);

    return () => clearInterval(timer);
  }, [active, text.length, maxWidth]);

  if (active && maxWidth > 0 && text.length > maxWidth) {
    return text.slice(scrollPos, scrollPos + maxWidth);
  }
  if (maxWidth > 0 && text.length > maxWidth) {
    return `${text.slice(0, maxWidth - 1)}…`;
  }
  return text;
}
