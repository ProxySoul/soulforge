import { fg as fgStyle, StyledText, TextAttributes, type TextRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { icon } from "../../core/icons.js";
import type { ProviderStatus } from "../../core/llm/provider.js";
import type { PrerequisiteStatus } from "../../core/setup/prerequisites.js";
import { getThemeTokens, useTheme } from "../../core/theme/index.js";
import { WORDMARK } from "../../core/utils/splash.js";
import { useMCPStore } from "../../stores/mcp.js";
import { useRepoMapStore } from "../../stores/repomap.js";
import { FlameLogo } from "./FlameLogo.js";
import { Spinner } from "./shared.js";

const BOLD = TextAttributes.BOLD;
const ITALIC = TextAttributes.ITALIC;

// ── Floating rune particles (imperative — zero re-renders) ──────────

const RUNE_POOL = "ᛁᚲᚠᛊᛏᛉᛞᚨᚱᚺᚾᛃᛇᛈᛋᛒᛗᛚᛝᛟ";

interface Particle {
  x: number;
  y: number;
  rune: string;
  speed: number;
  life: number; // 0→4 lifecycle
}

function spawnParticle(cols: number, rows: number): Particle {
  return {
    x: Math.floor(Math.random() * cols),
    y: Math.floor(Math.random() * rows),
    rune: RUNE_POOL[Math.floor(Math.random() * RUNE_POOL.length)] ?? "ᛁ",
    speed: 0.2 + Math.random() * 0.5,
    life: 0,
  };
}

function RuneField({ cols, rows }: { cols: number; rows: number }) {
  const textRef = useRef<TextRenderable>(null);
  const particlesRef = useRef<Particle[]>([]);
  const tickRef = useRef(0);
  const maxParticles = Math.min(10, Math.floor((cols * rows) / 120));

  useEffect(() => {
    // Seed a few particles at random lifecycle stages
    particlesRef.current = [];
    for (let i = 0; i < Math.floor(maxParticles / 3); i++) {
      const p = spawnParticle(cols, rows);
      p.life = 1 + Math.random() * 2; // start mid-life so they're visible
      particlesRef.current.push(p);
    }

    const timer = setInterval(() => {
      tickRef.current++;
      const particles = particlesRef.current;
      const tk = getThemeTokens();

      // Slowly spawn new particles
      if (particles.length < maxParticles && Math.random() < 0.08) {
        particles.push(spawnParticle(cols, rows));
      }

      // Build sparse grid
      const grid = new Map<string, { rune: string; color: string }>();

      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i] as Particle;
        p.life += 0.03 * p.speed;

        // Slow gentle drift upward
        p.y -= p.speed * 0.08;
        p.x += Math.sin(tickRef.current * 0.05 + i * 2) * 0.03;

        // Lifecycle: fade in (0-1) → visible (1-3) → fade out (3-4) → dead (4+)
        let alpha: number;
        if (p.life < 1) alpha = p.life;
        else if (p.life < 3) alpha = 1;
        else if (p.life < 4) alpha = 4 - p.life;
        else {
          particles.splice(i, 1);
          continue;
        }

        const gx = Math.round(p.x);
        const gy = Math.round(p.y);
        if (gx < 0 || gx >= cols || gy < 0 || gy >= rows) {
          particles.splice(i, 1);
          continue;
        }

        const color = alpha > 0.6 ? tk.brandDim : alpha > 0.3 ? tk.textFaint : tk.textSubtle;
        grid.set(`${String(gx)},${String(gy)}`, { rune: p.rune, color });
      }

      // Render sparse — only rune cells, rest is spaces
      const parts: ReturnType<ReturnType<typeof fgStyle>>[] = [];
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const cell = grid.get(`${String(x)},${String(y)}`);
          parts.push(cell ? fgStyle(cell.color)(cell.rune) : fgStyle(tk.textSubtle)(" "));
        }
        if (y < rows - 1) parts.push(fgStyle(tk.textSubtle)("\n"));
      }

      try {
        if (textRef.current) textRef.current.content = new StyledText(parts);
      } catch {}
    }, 250); // Slow tick — particles drift gently

    return () => clearInterval(timer);
  }, [cols, rows, maxParticles]);

  return (
    <box position="absolute" width={cols} height={rows}>
      <text ref={textRef}> </text>
    </box>
  );
}

// ── Ember line (imperative — zero re-renders) ───────────────────────

function buildEmberLine(tick: number, w: number): StyledText {
  const tk = getThemeTokens();
  const segments: ReturnType<ReturnType<typeof fgStyle>>[] = [];
  const center = w / 2;
  const breathe = Math.sin(tick * 0.15) * 0.5 + 0.5;

  for (let i = 0; i < w; i++) {
    const distFromCenter = Math.abs(i - center) / center;
    const wave = Math.sin(i * 0.3 + tick * 0.2) * 0.5 + 0.5;
    const intensity = (1 - distFromCenter) * (0.3 + breathe * 0.7) * wave;

    let char: string;
    let color: string;
    if (intensity > 0.7) {
      char = "━";
      color = tk.brandAlt;
    } else if (intensity > 0.4) {
      char = "─";
      color = tk.brand;
    } else if (intensity > 0.2) {
      char = "╌";
      color = tk.brandDim;
    } else {
      char = " ";
      color = tk.textSubtle;
    }
    segments.push(fgStyle(color)(char));
  }
  return new StyledText(segments);
}

function EmberDivider({ width: w }: { width: number }) {
  const ref = useRef<TextRenderable>(null);
  const tickRef = useRef(0);

  useEffect(() => {
    const timer = setInterval(() => {
      tickRef.current++;
      try {
        if (ref.current) ref.current.content = buildEmberLine(tickRef.current, w);
      } catch {}
    }, 100);
    return () => clearInterval(timer);
  }, [w]);

  return <text ref={ref} content={buildEmberLine(0, w)} />;
}

// ── Quips ────────────────────────────────────────────────────────────

const QUIPS = [
  "The forge awaits your command.",
  "The anvil is warm. What shall we build?",
  "The runes are aligned. Speak your intent.",
  "The blade is sharp. The code is ready.",
  "The ether hums with potential.",
  "Ready to transmute code into gold.",
  "Forge hot. Tools sharp. Let's ship.",
];

function getTimeQuip(): string {
  const h = new Date().getHours();
  if (h < 6) return "The forge burns at midnight.";
  if (h < 12) return "Morning forge session. Coffee recommended.";
  if (h < 17) return "Afternoon forging in progress.";
  if (h < 21) return "The runes glow brighter at dusk.";
  return "Late night forging. The spirits are restless.";
}

function pickQuip(): string {
  if (Math.random() < 0.3) return getTimeQuip();
  return QUIPS[Math.floor(Math.random() * QUIPS.length)] as string;
}

// ── Status block — model on top (colored), info below (muted) ───────

function StatusBlock() {
  const tk = useTheme();

  // Live repo map / LSP status
  const [repoState, setRepoState] = useState(() => {
    const s = useRepoMapStore.getState();
    return { status: s.status, lspStatus: s.lspStatus };
  });

  useEffect(
    () =>
      useRepoMapStore.subscribe((s) => {
        setRepoState((prev) => {
          if (prev.status === s.status && prev.lspStatus === s.lspStatus) return prev;
          return { status: s.status, lspStatus: s.lspStatus };
        });
      }),
    [],
  );

  // Live MCP server count
  const mcpReady = useMCPStore((s) => {
    let count = 0;
    for (const srv of Object.values(s.servers)) {
      if (srv.status === "ready") count++;
    }
    return count;
  });

  const { status, lspStatus } = repoState;

  // Only surface SoulMap / LSP when something is *not* in the steady ready
  // state — loading or errors. Healthy = silent.
  let mapNode: React.ReactNode;
  if (status === "scanning") {
    mapNode = (
      <text key="map">
        <Spinner inline color={tk.amber} suffix={" "} />
        <span fg={tk.amber}>SoulMap</span>
      </text>
    );
  } else if (status === "error") {
    mapNode = (
      <text key="map">
        <span fg={tk.error}>{icon("error")}</span>
        <span fg={tk.error}> SoulMap</span>
      </text>
    );
  }

  let lspNode: React.ReactNode;
  if (lspStatus === "generating") {
    lspNode = (
      <text key="lsp">
        <Spinner inline color={tk.amber} suffix={" "} />
        <span fg={tk.amber}>LSP</span>
      </text>
    );
  } else if (lspStatus === "error") {
    lspNode = (
      <text key="lsp">
        <span fg={tk.error}>{icon("error")}</span>
        <span fg={tk.error}> LSP</span>
      </text>
    );
  }

  // MCP only shown when ready (informational — keep)
  let mcpNode: React.ReactNode;
  if (mcpReady > 0) {
    mcpNode = (
      <text key="mcp">
        <span fg={tk.success}>{icon("check")}</span>
        <span fg={tk.textSecondary}> {String(mcpReady)} MCP</span>
      </text>
    );
  }

  const parts = [mapNode, lspNode, mcpNode].filter(Boolean);
  const joined: React.ReactNode[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      joined.push(
        <text key={`sep-${String(i)}`} fg={tk.textFaint}>
          {"  │  "}
        </text>,
      );
    }
    joined.push(parts[i]);
  }

  return (
    <box flexDirection="column" alignItems="center" gap={0}>
      {joined.length > 0 && (
        <box flexDirection="row" gap={0} justifyContent="center">
          {joined}
        </box>
      )}
    </box>
  );
}

// ── Main landing page ───────────────────────────────────────────────

interface LandingPageProps {
  bootProviders: ProviderStatus[];
  bootPrereqs: PrerequisiteStatus[];
  activeModel?: string;
}

export function LandingPage({
  bootProviders: _bp,
  bootPrereqs: _bq,
  activeModel: _am,
}: LandingPageProps) {
  const tk = useTheme();
  const { width, height } = useTerminalDimensions();
  const columns = width ?? 80;
  const rows = height ?? 24;

  const compact = rows < 18;
  const showWordmark = columns >= 35;
  const showRuneField = rows >= 16 && columns >= 50;

  // Wordmark is 84 cols wide; guard the flame behind enough terminal
  // real estate. flameCols must be ≥ wordmark width + padding so the
  // trailing "E" isn't clipped by the parent container border.
  const showFlame = columns >= 88 && rows >= 24;
  const flameCols = Math.min(88, columns - 2);
  // Total flame+wordmark grid height. Wordmark is 6 rows; rest is
  // flame. We reserve ~8 rows for status/spinner/input below, and
  // give the flame as much of the remaining vertical space as we can
  // so the tip has room to taper off into sparse embers rather than
  // clipping flat against the top boundary.
  const flameRows = Math.min(36, Math.max(14, rows - 8));

  const quip = useMemo(() => pickQuip(), []);

  const divW = Math.min(WORDMARK[0]?.length ?? 27, columns - 4);

  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
      {/* ── Floating rune particles (behind content) ── */}
      {showRuneField && <RuneField cols={columns} rows={rows} />}

      {/* Flexible top spacer — absorbs extra height so the content
          stack below always sits flush against the input. When the
          input grows or the status block expands, this shrinks first. */}
      <box flexGrow={1} flexShrink={1} minHeight={0} />

      {/* ── Content — always anchored to the bottom ── */}
      <box flexDirection="column" alignItems="center" gap={0} flexShrink={0} zIndex={1}>
        {/* ── Ghost (only when flame is NOT showing) ── */}
        {!showFlame && (
          <text fg={tk.brand} attributes={BOLD}>
            {icon("ghost")}
          </text>
        )}

        {/* ── Animated flame (preferred) or ASCII wordmark fallback ──
             The flame is the whole brand moment — when it's showing, we
             skip the wordmark/subtitle/tagline/divider/quip since the
             fire carries the vibe. On small terminals we fall back to
             the classic stack. */}
        {showFlame ? (
          <FlameLogo cols={flameCols} rows={flameRows} />
        ) : (
          <>
            {showWordmark ? (
              <>
                {WORDMARK.map((line) => (
                  <text key={line} fg={tk.brand} attributes={BOLD}>
                    {line}
                  </text>
                ))}
                <text fg={tk.textDim}>
                  <span fg={tk.brandAlt}>ᛊ</span>
                  <span fg={tk.textFaint}>·</span>
                  <span fg={tk.textDim}>ᛟ·ᚢ·ᛚ</span>
                  <span fg={tk.textFaint}>·</span>
                  <span fg={tk.brandAlt}>ᚠ</span>
                  <span fg={tk.textFaint}>·</span>
                  <span fg={tk.textDim}>ᛟ</span>
                  <span fg={tk.textFaint}>·</span>
                  <span fg={tk.brandAlt}>ᚱ</span>
                  <span fg={tk.textFaint}>·</span>
                  <span fg={tk.textDim}>ᚷ·ᛖ</span>
                </text>
              </>
            ) : (
              <text fg={tk.brand} attributes={BOLD}>
                SOULFORGE
              </text>
            )}

            {/* Tagline */}
            <text fg={tk.textMuted} attributes={ITALIC}>
              Graph-Powered Code Intelligence
            </text>

            {!compact && <box height={1} />}

            {/* Ember divider */}
            <EmberDivider width={divW} />

            {!compact && <box height={1} />}

            {/* Quip */}
            <text fg={tk.brandAlt} attributes={ITALIC}>
              {quip}
            </text>

            {!compact && <box height={1} />}
          </>
        )}

        {/* ── Status line: only appears when something is wrong / loading ── */}
        <StatusBlock />
      </box>
    </box>
  );
}
