import { useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { icon } from "../../core/icons.js";
import { useTheme } from "../../core/theme/index.js";
import { garble } from "../../core/utils/splash.js";

// Priority tiers:
//   1 = always show (core actions, no git/quit/stop)
//   2 = medium screens
//   3 = wide only
// labelShort = truncated label for medium screens
interface ShortcutDef {
  k: string;
  ic: string;
  l: string;
  ls: string; // short label
  tier: 1 | 2 | 3;
}

const SHORTCUTS: ShortcutDef[] = [
  { k: "^K", ic: icon("lightning"), l: "Palette", ls: "Palette", tier: 1 },
  { k: "^L", ic: icon("brain_alt"), l: "LLM", ls: "LLM", tier: 1 },
  { k: "^D", ic: icon("cog"), l: "Mode", ls: "Mode", tier: 1 },
  { k: "^E", ic: icon("pencil"), l: "Editor", ls: "Editor", tier: 2 },
  { k: "^S", ic: icon("skills"), l: "Skills", ls: "Skills", tier: 2 },
  { k: "^G", ic: icon("git"), l: "Git", ls: "Git", tier: 2 },
  { k: "^N", ic: icon("ghost"), l: "New Session", ls: "New", tier: 3 },
  { k: "^P", ic: icon("clock_alt"), l: "Sessions", ls: "Sessions", tier: 3 },
  { k: "^T", ic: icon("tabs"), l: "Tab", ls: "Tab", tier: 3 },
  { k: "^C", ic: icon("quit"), l: "Quit", ls: "Quit", tier: 3 },
];

// Hint segments: plain string = normal, {h: string} = highlighted (brand color)
type HintSegment = string | { h: string };
type Hint = HintSegment[];

const HINTS: Hint[] = [
  // Modes
  ["Type ", { h: "/mode auto" }, " — full autonomy, no permission prompts"],
  ["Type ", { h: "/lock-in" }, " — hides narration, just progress + final answer"],
  ["Type ", { h: "/mode architect" }, " — design-only analysis, no code changes"],
  ["Type ", { h: "/mode plan" }, " — research first, then a step-by-step plan"],

  // Hearth — remote control
  [
    "Run ",
    { h: "soulforge hearth start" },
    " to control your forge from ",
    { h: "Telegram" },
    " or ",
    { h: "Discord" },
  ],
  ["Type ", { h: "/hearth" }, " to pair your phone — approve edits with a tap"],
  // Checkpoints
  ["Hit ", { h: "^B" }, " / ", { h: "^F" }, " to walk back and forward through checkpoints"],
  ["Type ", { h: "/checkpoint undo" }, " to revert the last turn — files included"],

  // Tabs
  [
    "Each tab gets its own ",
    { h: "model" },
    ", ",
    { h: "mode" },
    ", and ",
    { h: "session" },
    " — try ",
    { h: "^T" },
  ],
  ["Type ", { h: "/claim" }, " to see which tab owns which files right now"],

  // Steering
  ["Type while Forge is working — ", { h: "steering" }, " redirects the agent mid-stream"],

  // Dispatch & router
  ["Type ", { h: "/router" }, " — cheap model for research, strong model for edits"],
  [
    "Type ",
    { h: "/provider-settings" },
    " to tune ",
    { h: "thinking" },
    ", ",
    { h: "effort" },
    ", and ",
    { h: "speed" },
  ],
  // Sessions
  ["Hit ", { h: "^P" }, " to browse and resume any previous session"],
  ["Type ", { h: "/session continue" }, " to pick up an interrupted generation"],
  ["Type ", { h: "/session export" }, " to save your chat as markdown or JSON"],

  // Intelligence
  ["Add a ", { h: "SOULFORGE.md" }, " to your repo — Forge reads it as project instructions"],
  ["Run ", { h: "/lsp install" }, " to add language servers for smarter navigation"],
  ["Run ", { h: "/diagnose" }, " to health-check your LSP and tree-sitter setup"],

  // Editor & terminals
  ["Forge can see the file open in your ", { h: "editor" }, " — open it with ", { h: "^E" }],
  ["Type ", { h: "/terminals new" }, " to get a persistent shell alongside chat"],
  ["Type ", { h: "/editor split" }, " to cycle the editor/chat ratio (40/50/60/70)"],

  // Hooks & MCP
  ["Type ", { h: "/hooks" }, " to run shell commands on agent events — auto-format on edit"],
  ["Type ", { h: "/mcp" }, " to plug in MCP servers — agent gets their tools as ", { h: "mcp__*" }],

  // Skills & memory
  ["Hit ", { h: "^S" }, " to browse and install ", { h: "community skills" }, " from skills.sh"],
  ["Ask Forge to ", { h: "remember" }, " a decision — it persists across sessions"],

  // Git
  ["Hit ", { h: "^G" }, " for the full git menu — commit, diff, stash, lazygit"],
  ["Type ", { h: "/git co-author" }, " to toggle the co-author trailer on commits"],

  // Context
  ["Running low on context? Type ", { h: "/compact" }, " to summarize and free space"],

  // Themes
  ["Type ", { h: "/theme" }, " to live-preview 24 themes with ", { h: "transparency" }, " support"],
  // Headless & CLI
  ["Run ", { h: "soulforge --headless" }, " for one-shot CLI mode — great for CI/CD"],
  ["Run ", { h: "soulforge --headless --chat" }, " for interactive multi-turn CLI sessions"],

  // Discovery
  ["Type ", { h: "/instructions" }, " to toggle which instruction files Forge reads"],
  ["Type ", { h: "/privacy" }, " to hide sensitive files from Forge — like .gitignore for AI"],
  ["Type ", { h: "/update" }, " to check for new SoulForge versions"],
];
function hintPlainText(hint: Hint): string {
  return hint.map((s) => (typeof s === "string" ? s : s.h)).join("");
}

/** Fisher-Yates shuffle (in-place, returns same array) */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i] as T;
    arr[i] = arr[j] as T;
    arr[j] = tmp;
  }
  return arr;
}

/** Build a shuffled index bag. When exhausted, reshuffle for the next round. */
function createHintBag(): { next: () => number } {
  let remaining: number[] = [];
  return {
    next() {
      if (remaining.length === 0) {
        remaining = HINTS.map((_, i) => i);
        shuffle(remaining);
      }
      return remaining.pop() as number;
    },
  };
}

// Glitch transition timing (matches lock-in header animation)
const HINT_INTERVAL = 45_000; // ms between hints
const HINT_DISPLAY = 10_000; // ms to show the hint
const GLITCH_FRAMES = 4;
const GLITCH_TICK = 50; // ms per glitch frame

type HintPhase = "shortcuts" | "glitch-out" | "hint" | "glitch-in";

/** Periodically swap shortcuts with a hint using a garble glitch transition.
 *  Uses elimination-random: each hint shows once in random order before any repeats. */
function useFooterHint(): { phase: HintPhase; hint: Hint; glitchText: string } {
  const [phase, setPhase] = useState<HintPhase>("shortcuts");
  const [glitchTick, setGlitchTick] = useState(-1);
  const hintRef = useRef(HINTS[0] as Hint);
  const bagRef = useRef(createHintBag());

  // Cycle: shortcuts → glitch-out → hint → glitch-in → shortcuts
  // The bag.next() call is inside the timeout callback — no stale closure issues
  // because bagRef is a stable ref and the bag mutates its own internal array.
  useEffect(() => {
    if (phase !== "shortcuts") return;
    const timer = setTimeout(() => {
      hintRef.current = HINTS[bagRef.current.next()] as Hint;
      setGlitchTick(0);
      setPhase("glitch-out");
    }, HINT_INTERVAL);
    return () => clearTimeout(timer);
  }, [phase]);

  // After hint display, glitch back to shortcuts
  useEffect(() => {
    if (phase !== "hint") return;
    const timer = setTimeout(() => {
      setGlitchTick(0);
      setPhase("glitch-in");
    }, HINT_DISPLAY);
    return () => clearTimeout(timer);
  }, [phase]);

  // Glitch animation ticks
  useEffect(() => {
    if (glitchTick < 0) return;
    if (glitchTick >= GLITCH_FRAMES) {
      setGlitchTick(-1);
      if (phase === "glitch-out") {
        setPhase("hint");
      } else if (phase === "glitch-in") {
        setPhase("shortcuts");
      }
      return;
    }
    const timer = setTimeout(() => setGlitchTick((t) => t + 1), GLITCH_TICK);
    return () => clearTimeout(timer);
  }, [glitchTick, phase]);

  const glitchText = glitchTick >= 0 ? garble(hintPlainText(hintRef.current)) : "";

  return { phase, hint: hintRef.current, glitchText };
}

// Estimate rendered width of a shortcut item: "^X icon label" + trailing gap
// key=2, space=1, icon=1, space+label=optional, gap=trailing
function itemWidth(label: string, gap: number): number {
  return 2 + 1 + 1 + (label ? 1 + label.length : 0) + gap;
}

type LabelMode = "full" | "short" | "none";

function calcWidth(tier: number, mode: LabelMode, gap: number): number {
  const items = SHORTCUTS.filter((s) => s.tier <= tier);
  const total = items.reduce((sum, s, i) => {
    const lbl = mode === "full" ? s.l : mode === "short" ? s.ls : "";
    return sum + itemWidth(lbl, i < items.length - 1 ? gap : 0);
  }, 0);
  return total + 2; // paddingX={1} on each side
}

export function Footer() {
  const { width } = useTerminalDimensions();
  const t = useTheme();
  const { phase, hint, glitchText } = useFooterHint();

  const GAP = 2;

  // Find the best (tier, labelMode) combo that fits on one line.
  // Try tier 3→2→1, and for each try full→short→icons-only label modes.
  let maxTier: 1 | 2 | 3 = 1;
  let labelMode: LabelMode = "none";
  let found = false;

  outer: for (const tier of [3, 2, 1] as const) {
    for (const mode of ["full", "short", "none"] as LabelMode[]) {
      const gap = mode === "none" ? 1 : GAP;
      if (calcWidth(tier, mode, gap) <= width) {
        maxTier = tier;
        labelMode = mode;
        found = true;
        break outer;
      }
    }
  }

  // Fallback: tier 1 icons-only always renders (even if it overflows slightly)
  if (!found) {
    maxTier = 1;
    labelMode = "none";
  }

  const visible = SHORTCUTS.filter((s) => s.tier <= maxTier);
  const showLabels = labelMode !== "none";

  // During glitch or hint phases, replace shortcuts with hint text
  const hintAvail = width - 4; // paddingX=1 + sparkle + space
  if (phase === "glitch-out" || phase === "glitch-in") {
    const g =
      hintAvail > 0 && glitchText.length > hintAvail
        ? `${glitchText.slice(0, hintAvail - 1)}…`
        : glitchText;
    return (
      <box flexDirection="row" justifyContent="center" paddingX={1} width="100%">
        <text>
          <span fg={t.textMuted}>{g}</span>
        </text>
      </box>
    );
  }

  if (phase === "hint") {
    const plain = hintPlainText(hint);
    const needsTruncate = hintAvail > 0 && plain.length > hintAvail;
    let charBudget = needsTruncate ? hintAvail - 1 : plain.length;

    return (
      <box flexDirection="row" justifyContent="center" paddingX={1} width="100%">
        <text>
          <span fg={t.textMuted}>{icon("sparkle")} </span>
          {hint.map((segment, i) => {
            if (charBudget <= 0) return null;
            const hl = typeof segment !== "string";
            const raw = hl ? segment.h : segment;
            let seg = raw;
            if (seg.length > charBudget) {
              seg = `${seg.slice(0, charBudget)}…`;
              charBudget = 0;
            } else {
              charBudget -= seg.length;
            }
            return (
              <span key={`${String(i)}-${String(hl)}`} fg={hl ? t.brand : t.textSecondary}>
                {seg}
              </span>
            );
          })}
        </text>
      </box>
    );
  }

  return (
    <box
      flexDirection="row"
      justifyContent="center"
      paddingX={1}
      width="100%"
      gap={showLabels ? GAP : 1}
    >
      {visible.map((s) => (
        <text key={s.k}>
          <span fg={t.textMuted}>
            <b>{s.k}</b>
          </span>
          <span fg={t.textDim}>
            {" "}
            {s.ic}
            {showLabels ? ` ${labelMode === "full" ? s.l : s.ls}` : ""}
          </span>
        </text>
      ))}
    </box>
  );
}
