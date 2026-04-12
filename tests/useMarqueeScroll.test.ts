import { describe, expect, it } from "bun:test";
import { getMarqueeDisplayText, tickMarquee } from "../src/hooks/useMarqueeScroll.js";

describe("tickMarquee", () => {
  it("runs start pause, scrolls, pauses at end, then resets", () => {
    const maxPos = 3;
    const pauseTicks = 2;
    let state = { scrollPos: 0, startPause: pauseTicks, endPause: 0 };

    state = tickMarquee(state, maxPos, pauseTicks);
    expect(state).toEqual({ scrollPos: 0, startPause: 1, endPause: 0 });

    state = tickMarquee(state, maxPos, pauseTicks);
    expect(state).toEqual({ scrollPos: 0, startPause: 0, endPause: 0 });

    state = tickMarquee(state, maxPos, pauseTicks);
    expect(state).toEqual({ scrollPos: 1, startPause: 0, endPause: 0 });

    state = tickMarquee(state, maxPos, pauseTicks);
    expect(state).toEqual({ scrollPos: 2, startPause: 0, endPause: 0 });

    state = tickMarquee(state, maxPos, pauseTicks);
    expect(state).toEqual({ scrollPos: 3, startPause: 0, endPause: 0 });

    state = tickMarquee(state, maxPos, pauseTicks);
    expect(state).toEqual({ scrollPos: 3, startPause: 2, endPause: 2 });

    state = tickMarquee(state, maxPos, pauseTicks);
    expect(state).toEqual({ scrollPos: 3, startPause: 2, endPause: 1 });

    state = tickMarquee(state, maxPos, pauseTicks);
    expect(state).toEqual({ scrollPos: 0, startPause: 2, endPause: 0 });
  });

  it("increments position while in normal scrolling range", () => {
    const next = tickMarquee({ scrollPos: 4, startPause: 0, endPause: 0 }, 6, 10);
    expect(next).toEqual({ scrollPos: 5, startPause: 0, endPause: 0 });
  });
});

describe("getMarqueeDisplayText", () => {
  it("returns empty when max width is zero or less", () => {
    expect(getMarqueeDisplayText("abcdef", 0, false, 0)).toBe("");
    expect(getMarqueeDisplayText("abcdef", -1, true, 3)).toBe("");
  });

  it("returns active marquee window and inactive truncated text", () => {
    expect(getMarqueeDisplayText("abcdef", 4, true, 1)).toBe("bcde");
    expect(getMarqueeDisplayText("abcdef", 4, false, 0)).toBe("abc…");
  });
});
