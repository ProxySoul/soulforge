import { useEffect, useMemo, useState } from "react";

const PURPLE = "#9B30FF";
const PURPLE_DIM = "#6B20B0";
const PURPLE_GLOW = "#BF5FFF";
const FAINT = "#1a1a2e";

/** Animated divider — a bright cursor sweeps across a dim line. */
export function ScanDivider({ width: w, speed = 120 }: { width: number; speed?: number }) {
  const [pos, setPos] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setPos((p) => (p + 1) % (w + 6)), speed);
    return () => clearInterval(timer);
  }, [w, speed]);

  const chars = useMemo(() => {
    const out: { ch: string; color: string }[] = [];
    for (let i = 0; i < w; i++) {
      const dist = Math.abs(i - pos);
      if (dist === 0) out.push({ ch: "━", color: PURPLE_GLOW });
      else if (dist === 1) out.push({ ch: "─", color: PURPLE });
      else if (dist === 2) out.push({ ch: "─", color: PURPLE_DIM });
      else out.push({ ch: "─", color: FAINT });
    }
    return out;
  }, [pos, w]);

  return (
    <box flexDirection="row">
      {chars.map((c, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional divider chars
        <text key={i} fg={c.color}>
          {c.ch}
        </text>
      ))}
    </box>
  );
}
