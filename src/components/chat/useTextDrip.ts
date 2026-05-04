import { useEffect, useRef, useState } from "react";

const TICK_MS = 32; // ~30fps drain loop
const MIN_SPEED = 0.8; // chars/tick floor
const MAX_SPEED = 16; // chars/tick ceiling
const ACCEL = 0.15; // velocity ramp-up per tick (easing)
const DECEL = 0.4; // velocity ramp-down when buffer drains
const CATCHUP_RAMP = 0.4; // extra accel when buffer is large (smooth catch-up)
const CATCHUP_THRESHOLD = 60; // buffer size to trigger catch-up

const STREAM_OPACITY = 0.65;
const FADE_IN_DURATION_MS = 300; // opacity fade-in when streaming starts
const FADE_OUT_DURATION_MS = 250; // opacity fade to 1.0 when streaming ends

/**
 * Drip-feeds text for a smooth typewriter effect during streaming.
 *
 * Features:
 * - Word-aware: snaps to word/punctuation boundaries instead of cutting mid-word
 * - Easing: velocity ramps up/down smoothly instead of stepping
 * - Catch-up: large buffer surges accelerate gradually, not instantly
 * - Fresh tracking: returns how many chars were just revealed (for dim→bright)
 *
 * Easy to remove: replace `useTextDrip(text, streaming)` with just
 * `{ text, freshCount: 0 }` or delete the hook entirely.
 */
export function useTextDrip(
  fullText: string,
  streaming: boolean,
): { text: string; freshCount: number; opacity: number } {
  const [drip, setDrip] = useState({ revealed: 0, fresh: 0 });
  const [opacity, setOpacity] = useState(streaming ? STREAM_OPACITY : 1);
  const bufferRef = useRef(0);
  const prevLenRef = useRef(0);
  const velocityRef = useRef(MIN_SPEED);
  const fullTextRef = useRef(fullText);
  fullTextRef.current = fullText;

  // Accumulate incoming content into buffer
  useEffect(() => {
    const delta = fullText.length - prevLenRef.current;
    if (delta > 0) {
      bufferRef.current += delta;
    }
    prevLenRef.current = fullText.length;
  }, [fullText]);

  // Smooth opacity transition: fade in when streaming starts, fade to 1.0 when it ends
  useEffect(() => {
    const start = Date.now();
    const from = streaming ? 1 : STREAM_OPACITY;
    const to = streaming ? STREAM_OPACITY : 1;
    const duration = streaming ? FADE_IN_DURATION_MS : FADE_OUT_DURATION_MS;

    const timer = setInterval(() => {
      const elapsed = Date.now() - start;
      const raw = Math.min(1, elapsed / duration);
      const eased = raw * (2 - raw); // outQuad
      const value = from + (to - from) * eased;
      setOpacity(value);
      if (raw >= 1) clearInterval(timer);
    }, TICK_MS);

    return () => clearInterval(timer);
  }, [streaming]);

  // Flush on stream end
  useEffect(() => {
    if (!streaming) {
      setDrip({ revealed: fullTextRef.current.length, fresh: 0 });
      bufferRef.current = 0;
      prevLenRef.current = fullTextRef.current.length;
      velocityRef.current = MIN_SPEED;
    }
  }, [streaming]);

  // Steady drain with easing
  useEffect(() => {
    if (!streaming) return;

    const timer = setInterval(() => {
      const buf = bufferRef.current;
      if (buf <= 0) {
        velocityRef.current = Math.max(MIN_SPEED, velocityRef.current * DECEL);
        setDrip((prev) => (prev.fresh === 0 ? prev : { ...prev, fresh: 0 }));
        return;
      }

      const accel = buf > CATCHUP_THRESHOLD ? ACCEL + CATCHUP_RAMP : ACCEL;
      const targetSpeed = Math.min(MAX_SPEED, MIN_SPEED + buf * 0.08);
      velocityRef.current = Math.min(
        MAX_SPEED,
        velocityRef.current + (targetSpeed - velocityRef.current) * accel,
      );

      const rawChars = Math.max(1, Math.round(velocityRef.current));
      const drain = Math.min(rawChars, buf);

      setDrip((prev) => {
        const target = Math.min(prev.revealed + drain, fullTextRef.current.length);
        const snapped = snapToWordBoundary(fullTextRef.current, prev.revealed, target);
        const actual = snapped - prev.revealed;
        bufferRef.current = Math.max(0, bufferRef.current - actual);
        return { revealed: snapped, fresh: actual };
      });
    }, TICK_MS);

    return () => clearInterval(timer);
  }, [streaming]);

  if (!streaming) return { text: fullText, freshCount: 0, opacity };

  return { text: fullText.slice(0, drip.revealed), freshCount: drip.fresh, opacity };
}

function snapToWordBoundary(text: string, from: number, target: number): number {
  if (target >= text.length) return text.length;

  let cut = target;

  // 1. Never split a UTF-16 surrogate pair.
  const code = text.charCodeAt(cut);
  if (code >= 0xdc00 && code <= 0xdfff) {
    // We're on a low surrogate — back up onto the high surrogate.
    cut = Math.max(from, cut - 1);
  }

  // 2. Never split inside an ANSI escape sequence (ESC [ ... letter).
  const esc = text.lastIndexOf("\x1b", cut);
  if (esc >= from && esc < cut) {
    // Find the terminator (any letter ends a CSI).
    let end = esc + 1;
    while (end < text.length && !/[A-Za-z]/.test(text[end] ?? "")) end++;
    if (end >= cut) {
      // Cut would land inside the escape — back up before ESC, or skip past it.
      const before = esc;
      const after = Math.min(text.length, end + 1);
      cut = after - cut < cut - before ? after : before;
    }
  }

  if (cut >= text.length) return text.length;
  if (cut <= from) return from;

  // 3. Snap to grapheme boundary using Intl.Segmenter when available.
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    // Scan from `from` forward to find the grapheme boundary nearest target.
    const slice = text.slice(from, Math.min(text.length, cut + 8));
    let lastBoundary = 0;
    for (const { index } of seg.segment(slice)) {
      const abs = from + index;
      if (abs > cut) break;
      lastBoundary = index;
    }
    cut = from + lastBoundary;
  }

  if (cut >= text.length) return text.length;

  // 4. Prefer a word/punctuation boundary within a small window.
  const ch = text[cut];
  if (!ch || /[\s.,;:!?\-\n\r]/.test(ch)) return cut;

  for (let i = cut + 1; i < Math.min(cut + 8, text.length); i++) {
    const c = text[i];
    if (c && /[\s.,;:!?\-\n\r]/.test(c)) return i;
  }

  for (let i = cut - 1; i > Math.max(from, cut - 4); i--) {
    const c = text[i];
    if (c && /[\s.,;:!?\-\n\r]/.test(c)) return i + 1;
  }

  return cut;
}
