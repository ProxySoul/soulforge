import { fg as fgStyle, StyledText, TextAttributes, type TextRenderable } from "@opentui/core";
import { useEffect, useMemo, useRef } from "react";
import { useTheme } from "../../core/theme/index.js";

// ── Flame + wordmark logo ──────────────────────────────────────────
//
// Animated Doom-fire flame above a 3D block-letter SOULFORGE wordmark.
// Heat sources sit on a narrow centered band; heat propagates upward
// with lateral drift and per-row cooling, producing tapered tongues
// that flicker naturally. Wordmark below uses a 3-tier color gradient
// (highlight / face / shadow) for chiseled depth.

// ── Heat → (char, colorKey) ramp ─────────────────────────────────────

type HeatColor = "whiteHot" | "amber" | "brand" | "brandAlt" | "brandDim" | "textFaint";

interface HeatCell {
  ch: string;
  key: HeatColor;
}

function heatToCell(h: number): HeatCell {
  if (h >= 0.92) return { ch: "#", key: "amber" };
  if (h >= 0.8) return { ch: "#", key: "amber" };
  if (h >= 0.68) return { ch: "*", key: "amber" };
  if (h >= 0.56) return { ch: "*", key: "brand" };
  if (h >= 0.44) return { ch: "+", key: "brand" };
  if (h >= 0.32) return { ch: "=", key: "brandAlt" };
  if (h >= 0.22) return { ch: "-", key: "brandDim" };
  if (h >= 0.14) return { ch: ":", key: "textFaint" };
  if (h >= 0.07) return { ch: ".", key: "textFaint" };
  return { ch: " ", key: "textFaint" };
}

// ── Sim ──────────────────────────────────────────────────────────────

interface FlameSim {
  cols: number;
  rows: number;
  heat: Float32Array; // row-major, rows * cols
  // Per-column base heat at the source row. Masked to a narrow band
  // centered over the anvil's plate with smoothstep falloff, so the
  // flame naturally tapers at the edges.
  sourceMask: Float32Array;
}

function makeSim(cols: number, rows: number, flameWidth: number): FlameSim {
  const heat = new Float32Array(cols * rows);
  const sourceMask = new Float32Array(cols);

  const cx = (cols - 1) / 2;
  const halfW = flameWidth / 2;
  for (let x = 0; x < cols; x++) {
    const d = Math.abs(x - cx) / halfW; // 0 at center, 1 at flame edge
    if (d >= 1) {
      sourceMask[x] = 0;
      continue;
    }
    // Smoothstep falloff — hot at center, soft at edges.
    const t = 1 - d;
    sourceMask[x] = t * t * (3 - 2 * t);
  }
  return { cols, rows, heat, sourceMask };
}

function stepSim(sim: FlameSim, intensity: number, breath: number): void {
  const { cols, rows, heat, sourceMask } = sim;
  const sourceY = rows - 1;
  const cx = (cols - 1) / 2;

  // 1. Refresh heat sources on the bottom row.
  for (let x = 0; x < cols; x++) {
    const m = sourceMask[x] ?? 0;
    if (m === 0) {
      heat[sourceY * cols + x] = 0;
      continue;
    }
    const jitter = 0.75 + Math.random() * 0.25;
    heat[sourceY * cols + x] = Math.min(1, m * jitter * intensity * breath);
  }

  // 2. Propagate upward. Three effects shape the tip into a triangle:
  //    - Upper rows cool faster (tapered height).
  //    - Upper rows bias lateral drift INWARD toward center (narrowing).
  //    - Only the very top 3 rows apply a small extra decay, so the
  //      flame fragments into sparse embers before the boundary rather
  //      than cutting flat — but tongues still reach most of the way up.
  const TOP_FADE_ROWS = 3;
  for (let y = 0; y < sourceY; y++) {
    const heightT = 1 - y / Math.max(1, sourceY); // 1 at bottom → 0 at top
    const narrowing = 1 - heightT; // 0 at bottom → 1 at top
    // Top-zone boost: only kicks in for last 3 rows, gentle ramp.
    const topFade = y < TOP_FADE_ROWS ? ((TOP_FADE_ROWS - y) / TOP_FADE_ROWS) * 0.02 : 0;
    for (let x = 0; x < cols; x++) {
      // Inward bias increases with height — distant cells pull more
      // from their center-side neighbor.
      const toCenter = x < cx ? 1 : x > cx ? -1 : 0;
      let rand = Math.floor(Math.random() * 3) - 1;
      if (narrowing > 0.4 && Math.random() < narrowing * 0.5) {
        rand = toCenter;
      }
      const srcX = Math.min(cols - 1, Math.max(0, x + rand));
      const decay = Math.random() * 0.025 + 0.008 + heightT * 0.008 + topFade;
      const below = heat[(y + 1) * cols + srcX] ?? 0;
      heat[y * cols + x] = Math.max(0, below - decay);
    }
  }
}

// ── Render ───────────────────────────────────────────────────────────

// Sample the flame heat around (x, y) with distance falloff — used to
// tint wordmark glyphs. Samples a wider radius than a simple max so
// letters further from the flame still pick up dim ambient glow.
// Heat above the cell matters most (fire radiates upward/downward).
function sampleNeighborHeat(
  heat: Float32Array,
  cols: number,
  rows: number,
  x: number,
  y: number,
): number {
  let weighted = heat[y * cols + x] ?? 0;
  // Search a 5-wide, 6-tall (mostly upward) window with 1/distance falloff.
  for (let dy = -4; dy <= 1; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
      const h = heat[ny * cols + nx] ?? 0;
      if (h <= 0) continue;
      // Attenuation: inverse of Chebyshev distance.
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      const contribution = h / (dist + 1);
      if (contribution > weighted) weighted = contribution;
    }
  }
  return weighted;
}

// Compute a 0..1 "flame intensity" for the whole frame — the average of
// the top 20% of heat values in the flame region. Smoothed over frames
// via a simple EMA to avoid nervous tint flicker.
function computeGlobalIntensity(heat: Float32Array, cols: number, flameEndY: number): number {
  // Sum heat in flame region, find running max at each y to represent tongue height.
  let sum = 0;
  let count = 0;
  for (let y = 0; y < flameEndY; y++) {
    let rowMax = 0;
    for (let x = 0; x < cols; x++) {
      const h = heat[y * cols + x] ?? 0;
      if (h > rowMax) rowMax = h;
    }
    // Weight upper rows higher — tall flames = high intensity.
    const weight = 1 - y / Math.max(1, flameEndY);
    sum += rowMax * weight;
    count += weight;
  }
  return count > 0 ? Math.min(1, sum / count) : 0;
}

// Linear interpolate between two #rrggbb hex colors. t = 0 returns a, t = 1 returns b.
function lerpHex(a: string, b: string, t: number): string {
  const ar = parseInt(a.slice(1, 3), 16);
  const ag = parseInt(a.slice(3, 5), 16);
  const ab = parseInt(a.slice(5, 7), 16);
  const br = parseInt(b.slice(1, 3), 16);
  const bg = parseInt(b.slice(3, 5), 16);
  const bb = parseInt(b.slice(5, 7), 16);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bl.toString(16).padStart(2, "0")}`;
}

// Composite render: flame fills the entire grid, and the wordmark is
// overlaid on the bottom WORDMARK_H rows. Where the wordmark has a
// non-space glyph we draw it (tinted toward amber based on nearby flame
// heat AND the global flame intensity); where it has a space the flame
// shows through from behind.
//
// The global-intensity multiplier means: when the flame surges high,
// ALL letters get a unified warm wash, and when it dies down they fall
// back to cool purple — creates a coherent "lit by fire" feel instead
// of nervous per-cell flicker.
function renderComposite(
  sim: FlameSim,
  palette: Record<HeatColor, string>,
  brand: string,
  highlight: string,
  shadow: string,
  amber: string,
  globalIntensity: number,
  breathPhase: number,
): StyledText {
  const { cols, rows, heat } = sim;
  const parts: ReturnType<ReturnType<typeof fgStyle>>[] = [];
  const dark = palette.textFaint;

  const wmRows = WORDMARK.length;
  const wmOff = Math.max(0, Math.floor((cols - WM_W) / 2));
  const wmStartY = rows - wmRows;

  // Global tint — hard dead zone below 0.35, then fast ramp. Letters
  // stay purple when the flame is low (no ambient wash), heat up fast
  // once fire is strong. intensity < 0.35 → 0, 0.5 → 0.12, 0.7 → 0.46,
  // 1.0 → 1.0.
  const tintStrength = globalIntensity < 0.35 ? 0 : ((globalIntensity - 0.35) / 0.65) ** 1.3;

  // Breath brightness: 0.82…1.0 multiplier synced to flame breath.
  const breathMul = 0.82 + breathPhase * 0.18;

  // Smooth row gradient: highlight → brand → shadow. When flame is low,
  // deepen the shadow side (unlit letters fall into darkness).
  const shadowDeepening = 1 - globalIntensity * 0.5;
  const deepShadow = lerpHex(shadow, dark, 1 - shadowDeepening);
  const rowColors: string[] = [];
  for (let r = 0; r < wmRows; r++) {
    const t = wmRows === 1 ? 0.5 : r / (wmRows - 1);
    const col =
      t < 0.5 ? lerpHex(highlight, brand, t * 2) : lerpHex(brand, deepShadow, (t - 0.5) * 2);
    // Breath brightness: pulse toward shadow when phase is low.
    rowColors.push(lerpHex(deepShadow, col, breathMul));
  }

  for (let y = 0; y < rows; y++) {
    const inWordmark = y >= wmStartY;
    const wmRowIdx = y - wmStartY;
    const wmRow = inWordmark ? (WORDMARK[wmRowIdx] ?? "") : "";
    const baseColor = inWordmark ? (rowColors[wmRowIdx] ?? brand) : brand;

    for (let x = 0; x < cols; x++) {
      if (inWordmark) {
        const wmX = x - wmOff;
        if (wmX >= 0 && wmX < wmRow.length) {
          const ch = wmRow[wmX];
          if (ch && ch !== " ") {
            const localHeat = sampleNeighborHeat(heat, cols, rows, x, y);
            // Local is gated by tintStrength so individual hot cells
            // can't tint when the overall flame is weak — fire must be
            // alive for letters to glow.
            const localScale = Math.min(1, 0.2 + tintStrength * 1.6);
            const tint = Math.min(1, localHeat * 1.1 * localScale + tintStrength * 0.7);
            const litColor = tint > 0.04 ? lerpHex(baseColor, amber, tint) : baseColor;
            parts.push(fgStyle(litColor)(ch));
            continue;
          }
        }
      }
      // Fall through to flame.
      const cell = heatToCell(heat[y * cols + x] ?? 0);
      parts.push(fgStyle(palette[cell.key])(cell.ch));
    }
    if (y < rows - 1) parts.push(fgStyle(dark)("\n"));
  }
  return new StyledText(parts);
}

// ── Wordmark — bold "SOULFORGE" with 3D depth ────────────────────────
//
// 5-row block-letter wordmark using full/half block chars for a chunky
// forged-metal look. Each row gets a different shade to create
// top-lit depth:
//   row 0-1 (highlight): brandAlt — catches light from the flame above
//   row 2-3 (face):      brand    — main body color
//   row 4   (shadow):    brandDim — drop shadow / underside

const WORDMARK: string[] = [
  "███████╗  ██████╗  ██╗   ██╗ ██╗      ███████╗  ██████╗  ██████╗   ██████╗  ███████╗",
  "██╔════╝ ██╔═══██╗ ██║   ██║ ██║      ██╔════╝ ██╔═══██╗ ██╔══██╗ ██╔════╝  ██╔════╝",
  "███████╗ ██║   ██║ ██║   ██║ ██║      █████╗   ██║   ██║ ██████╔╝ ██║  ███╗ █████╗  ",
  "╚════██║ ██║   ██║ ██║   ██║ ██║      ██╔══╝   ██║   ██║ ██╔══██╗ ██║   ██║ ██╔══╝  ",
  "███████║ ╚██████╔╝ ╚██████╔╝ ███████╗ ██║      ╚██████╔╝ ██║  ██║ ╚██████╔╝ ███████╗",
  "╚══════╝  ╚═════╝   ╚═════╝  ╚══════╝ ╚═╝       ╚═════╝  ╚═╝  ╚═╝  ╚═════╝  ╚══════╝",
];

const WM_W = WORDMARK[0]?.length ?? 0;

// ── Component ────────────────────────────────────────────────────────

export interface FlameLogoProps {
  /** Grid width (cols). Wordmark is centered horizontally. */
  cols: number;
  /** Total height in rows. The wordmark occupies the bottom WORDMARK_ROWS
   *  rows; everything above is flame that burns behind the letters. */
  rows: number;
}

const BOLD = TextAttributes.BOLD;

export function FlameLogo({ cols, rows }: FlameLogoProps) {
  const tk = useTheme();
  const ref = useRef<TextRenderable>(null);

  const intensityRef = useRef(0);
  const breathRef = useRef(1);
  // Smoothed global flame intensity — EMA of the per-frame measurement
  // so the wordmark glow breathes rather than flickers.
  const globalIntensityRef = useRef(0);

  // Flame spans a band slightly wider than the wordmark for licking
  // tongues at the edges.
  const flameWidth = useMemo(() => Math.min(cols - 2, WM_W + 6), [cols]);
  const sim = useMemo(() => makeSim(cols, rows, flameWidth), [cols, rows, flameWidth]);

  // Breath phase in [0, 1] — feeds wordmark brightness pulse so letters
  // brighten and dim in sync with the flame's breath.
  const breathPhaseRef = useRef(0.5);

  // Reset sim when dims change.
  useEffect(() => {
    sim.heat.fill(0);
    intensityRef.current = 0;
    globalIntensityRef.current = 0;
  }, [sim]);

  // Intro (outExpo, 1200ms) + breath pulse (inOutSine, 2.8s loop) @ 30fps.
  useEffect(() => {
    const startedAt = Date.now();
    const INTRO_MS = 1200;
    const tick = () => {
      const t = Date.now() - startedAt;
      const introT = Math.min(1, t / INTRO_MS);
      intensityRef.current = introT >= 1 ? 1 : 1 - 2 ** (-10 * introT);
      if (intensityRef.current >= 0.999) {
        const phase = ((t - INTRO_MS) / 2800) * Math.PI * 2;
        breathRef.current = 0.9 + Math.sin(phase) * 0.15;
        breathPhaseRef.current = (Math.sin(phase) + 1) * 0.5;
      } else {
        breathRef.current = 1;
        breathPhaseRef.current = 0.5;
      }
    };
    tick();
    const id = setInterval(tick, 33);
    return () => clearInterval(id);
  }, []);

  // Flame sim + composite render @ 10fps.
  useEffect(() => {
    const palette: Record<HeatColor, string> = {
      whiteHot: "#ffffff",
      amber: tk.amber,
      brand: tk.brand,
      brandAlt: tk.brandAlt,
      brandDim: tk.brandDim,
      textFaint: tk.textFaint,
    };
    const id = setInterval(() => {
      try {
        stepSim(sim, intensityRef.current, breathRef.current);
        // Measure frame intensity and EMA-smooth it so the wordmark
        // glow follows the flame's overall surge/decay instead of
        // flickering per-cell. alpha=0.15 → ~0.5s half-life at 10fps.
        const flameEndY = rows - WORDMARK.length;
        const measured = computeGlobalIntensity(sim.heat, cols, flameEndY);
        globalIntensityRef.current = globalIntensityRef.current * 0.85 + measured * 0.15;
        if (ref.current) {
          ref.current.content = renderComposite(
            sim,
            palette,
            tk.brand,
            tk.brandAlt,
            tk.brandDim,
            tk.amber,
            globalIntensityRef.current,
            breathPhaseRef.current,
          );
        }
      } catch {
        // Renderable torn down mid-tick during unmount.
      }
    }, 100);
    return () => clearInterval(id);
  }, [sim, tk]);

  return (
    <box flexDirection="column" alignItems="center" gap={0}>
      <text ref={ref} attributes={BOLD}>
        {" "}
      </text>
    </box>
  );
}

/** Wordmark block height in rows — for landing page layout sizing. */
export const WORDMARK_ROWS = WORDMARK.length;
