import { TextAttributes } from "@opentui/core";
import { memo, type ReactNode, useEffect, useRef, useState } from "react";
import { icon } from "../../core/icons.js";
import { useTheme } from "../../core/theme/index.js";
import { resolveToolDisplay } from "../../core/tool-display.js";
import { garble } from "../../core/utils/splash.js";
import { SPINNER_FRAMES, useSpinnerFrame } from "../layout/shared.js";

export const LOCKIN_EDIT_TOOLS = new Set([
  "edit_file",
  "multi_edit",
  "write_file",
  "create_file",
  "rename_file",
  "move_symbol",
  "rename_symbol",
]);

const QUIET_TOOLS = new Set(["update_plan_step", "ask_user", "task_list"]);

const MAX_VISIBLE = 5;
const ROTATE_INTERVAL = 8000;
const GLITCH_FRAMES = 4;
const GLITCH_TICK = 50;

// Phase-specific spinners for lock-in status header
const SPIN_EXPLORE = ["◴", "◷", "◶", "◵"];
const SPIN_EDIT = ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "█", "▉", "▊", "▋", "▌", "▍", "▎", "▏"];
const SPIN_DISPATCH = ["◇", "◈", "◆", "◈"];
const DOTS_CYCLE = [".", "..", "...", "..", ".", ".."];

const EXPLORE_PAIRS: [string, string][] = [
  ["Scanning the codebase…", "Scanned the codebase"],
  ["Reading the runes…", "Read the runes"],
  ["Tracing the threads…", "Traced the threads"],
  ["Mapping the terrain…", "Mapped the terrain"],
  ["Gathering intel…", "Gathered intel"],
  ["Following the trail…", "Followed the trail"],
  ["Consulting the index…", "Consulted the index"],
  ["Scouting ahead…", "Scouted ahead"],
  ["Connecting the dots…", "Connected the dots"],
  ["Parsing the signals…", "Parsed the signals"],
];

const EDIT_PAIRS: [string, string][] = [
  ["Forging changes…", "Forged changes"],
  ["Hammering code…", "Hammered code"],
  ["Shaping the metal…", "Shaped the metal"],
  ["Welding it together…", "Welded it together"],
  ["Carving the solution…", "Carved the solution"],
  ["Applying the fix…", "Applied the fix"],
  ["Rewriting reality…", "Rewrote reality"],
  ["Bending the code…", "Bent the code"],
  ["Crafting the patch…", "Crafted the patch"],
  ["Tempering the build…", "Tempered the build"],
];

const DISPATCH_PAIRS: [string, string][] = [
  ["Summoning mini forges…", "Mini forges delivered"],
  ["Lighting little forges…", "Little forges completed"],
  ["Splitting into sparks…", "Sparks reunited"],
  ["Deploying the swarm…", "Swarm returned"],
  ["Forking the flame…", "Flames merged"],
  ["Rallying the anvils…", "Anvils reported back"],
];

export interface LockInTool {
  id: string;
  name: string;
  done: boolean;
  error: boolean;
  argStr: string;
}

export function filterQuietTools(name: string): boolean {
  return !QUIET_TOOLS.has(name);
}

/** Rotating status message with glitch transition */
function useRotatingMessage(pairs: [string, string][], done: boolean) {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * pairs.length));
  const [glitchTick, setGlitchTick] = useState(-1);
  const pairsRef = useRef(pairs);
  pairsRef.current = pairs;

  // Rotate on interval (streaming only)
  useEffect(() => {
    if (done) return;
    const timer = setInterval(() => {
      setGlitchTick(0);
    }, ROTATE_INTERVAL);
    return () => clearInterval(timer);
  }, [done]);

  // Glitch animation ticks
  useEffect(() => {
    if (glitchTick < 0) return;
    if (glitchTick >= GLITCH_FRAMES * 2) {
      setGlitchTick(-1);
      return;
    }
    // Advance to new message at the midpoint
    if (glitchTick === GLITCH_FRAMES) {
      setIndex((prev) => {
        let next = Math.floor(Math.random() * pairsRef.current.length);
        if (next === prev && pairsRef.current.length > 1)
          next = (prev + 1) % pairsRef.current.length;
        return next;
      });
    }
    const timer = setTimeout(() => setGlitchTick((t) => t + 1), GLITCH_TICK);
    return () => clearTimeout(timer);
  }, [glitchTick]);

  // When pairs array changes (phase shift), pick new index
  useEffect(() => {
    setIndex(Math.floor(Math.random() * pairs.length));
    setGlitchTick(0);
  }, [pairs]);

  const pair = pairs[index % pairs.length] as [string, string];
  const raw = done ? pair[1] : pair[0];
  // Strip trailing … — animated dots added separately by caller
  const text = glitchTick >= 0 ? garble(raw.replace(/…$/, "")) : raw.replace(/…$/, "");

  return text;
}

/**
 * Lock-in view — status header + rail with last-5 tools.
 * Status message rotates with glitch transition.
 */
export const LockInWrapper = memo(function LockInWrapper({
  hasEdits,
  hasDispatch,
  done,
  seed: _seed,
  tools,
  children,
  loadingStartedAt = 0,
}: {
  hasEdits: boolean;
  hasDispatch?: boolean;
  done: boolean;
  seed: number;
  tools: LockInTool[];
  children?: ReactNode;
  loadingStartedAt?: number;
}) {
  const t = useTheme();
  const frame = useSpinnerFrame();

  const effectiveDone = done;
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (effectiveDone || !loadingStartedAt) return;
    const tick = () => setElapsed(Math.floor((Date.now() - loadingStartedAt) / 1000));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [effectiveDone, loadingStartedAt]);

  const pairs = hasDispatch ? DISPATCH_PAIRS : hasEdits ? EDIT_PAIRS : EXPLORE_PAIRS;
  const statusMsg = useRotatingMessage(pairs, effectiveDone);
  const statusColor = hasDispatch ? t.info : hasEdits ? t.warning : t.brand;
  const spinFrames = hasDispatch ? SPIN_DISPATCH : hasEdits ? SPIN_EDIT : SPIN_EXPLORE;
  const spinChar = spinFrames[frame % spinFrames.length] ?? "◴";

  const hiddenCount = Math.max(0, tools.length - MAX_VISIBLE);
  const hidden = tools.slice(0, hiddenCount);
  const hiddenEdits = hidden.filter((tc) => LOCKIN_EDIT_TOOLS.has(tc.name)).length;
  const visible = tools.slice(-MAX_VISIBLE);

  return (
    <box flexDirection="column" marginTop={1}>
      {/* Status header */}
      <box height={1} flexShrink={0}>
        <text truncate>
          {effectiveDone ? (
            <span fg={t.success}>{"✓ "}</span>
          ) : (
            <span fg={statusColor} attributes={TextAttributes.BOLD}>
              {spinChar}{" "}
            </span>
          )}
          <span
            fg={effectiveDone ? t.textSecondary : t.textPrimary}
            attributes={effectiveDone ? undefined : TextAttributes.BOLD}
          >
            {statusMsg}
          </span>
          {effectiveDone ? null : (
            <span fg={t.textMuted}>
              {(DOTS_CYCLE[Math.floor(frame / 3) % DOTS_CYCLE.length] ?? ".").padEnd(3)}
            </span>
          )}
          {!effectiveDone && elapsed > 0 ? <span fg={t.textFaint}>{String(elapsed)}s</span> : null}
        </text>
      </box>

      {/* Tool rail */}
      {visible.length > 0 || children ? (
        <box
          flexDirection="column"
          border={["left"]}
          borderColor={effectiveDone ? t.textFaint : t.textMuted}
          paddingLeft={1}
          opacity={effectiveDone ? 0.6 : 1}
        >
          {hiddenCount > 0 ? (
            <box height={1} flexShrink={0}>
              <text truncate>
                <span fg={t.textDim}>
                  {icon("check")} +{String(hiddenCount)} completed
                  {hiddenEdits > 0 ? ` [${String(hiddenEdits)} edits]` : ""}
                </span>
              </text>
            </box>
          ) : null}
          {visible.map((tc, i) => {
            const { icon: toolIcon, iconColor } = resolveToolDisplay(tc.name, t.textMuted);
            const isLast = i === visible.length - 1 && !children;
            const connector =
              visible.length < 2 && !children
                ? "  "
                : isLast
                  ? "└ "
                  : i === 0 && hiddenCount === 0
                    ? "┌ "
                    : "├ ";
            const statusChar = tc.done
              ? tc.error
                ? "✗"
                : "✓"
              : (SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "⠋");
            const statusClr = tc.done ? (tc.error ? t.error : t.success) : t.brand;

            return (
              <box key={tc.id} height={1} flexShrink={0}>
                <text truncate>
                  <span fg={t.textFaint}>{connector}</span>
                  <span fg={statusClr}>{statusChar}</span>
                  <span fg={tc.done ? t.textDim : iconColor}> {toolIcon} </span>
                  <span fg={tc.done ? t.textDim : t.textSecondary}>{tc.argStr || tc.name}</span>
                </text>
              </box>
            );
          })}
          {children}
        </box>
      ) : null}
    </box>
  );
});
