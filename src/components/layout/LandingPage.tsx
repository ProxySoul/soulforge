import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { icon, providerIcon } from "../../core/icons.js";
import type { ProviderStatus } from "../../core/llm/provider.js";
import type { PrerequisiteStatus } from "../../core/setup/prerequisites.js";
import { useRepoMapStore } from "../../stores/repomap.js";
import { SPINNER_FRAMES } from "./shared.js";

const PURPLE = "#9B30FF";
const RED = "#FF0040";
const FAINT = "#222";
const MUTED = "#555";
const SUBTLE = "#444";
const GREEN = "#4a7";
const AMBER = "#b87333";

const WORDMARK = [
  "┌─┐┌─┐┬ ┬┬  ┌─┐┌─┐┬─┐┌─┐┌─┐",
  "└─┐│ ││ ││  ├┤ │ │├┬┘│ ┬├┤ ",
  "└─┘└─┘└─┘┴─┘└  └─┘┴└─└─┘└─┘",
];

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lerpHex(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const bl = Math.round(b1 + (b2 - b1) * t);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bl.toString(16).padStart(2, "0")}`;
}

function GradientLine({ text, from, to }: { text: string; from: string; to: string }) {
  const len = text.length;
  if (len === 0) return null;

  const segments: { chars: string; color: string }[] = [];
  const CHUNK = 4;

  for (let i = 0; i < len; i += CHUNK) {
    const slice = text.slice(i, i + CHUNK);
    const t = len > 1 ? i / (len - 1) : 0;
    const color = lerpHex(from, to, t);
    segments.push({ chars: slice, color });
  }

  return (
    <box flexDirection="row">
      {segments.map((seg, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stable gradient segments
        <text key={i} fg={seg.color} attributes={TextAttributes.BOLD}>
          {seg.chars}
        </text>
      ))}
    </box>
  );
}

interface LandingPageProps {
  bootProviders: ProviderStatus[];
  bootPrereqs: PrerequisiteStatus[];
}

export function LandingPage({ bootProviders, bootPrereqs }: LandingPageProps) {
  const { width, height } = useTerminalDimensions();
  const columns = width ?? 80;
  const rows = height ?? 24;

  const compact = rows < 20;

  const showWordmark = columns >= 35;
  const wordmarkW = showWordmark ? (WORDMARK[0]?.length ?? 0) : 0;

  const activeProviders = useMemo(() => bootProviders.filter((p) => p.available), [bootProviders]);
  const inactiveProviders = useMemo(
    () => bootProviders.filter((p) => !p.available),
    [bootProviders],
  );
  const missingRequired = useMemo(
    () => bootPrereqs.filter((p) => !p.installed && p.prerequisite.required),
    [bootPrereqs],
  );
  const allToolsOk = useMemo(
    () => bootPrereqs.every((p) => p.installed || !p.prerequisite.required),
    [bootPrereqs],
  );
  const anyProvider = activeProviders.length > 0;

  const maxProviderWidth = Math.floor(columns * 0.6);
  const { visible: visibleProviders, overflow: providerOverflow } = fitProviders(
    activeProviders,
    inactiveProviders,
    maxProviderWidth,
  );

  const divW = Math.min(wordmarkW || 30, columns - 8);

  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} justifyContent="center">
      <box flexDirection="column" alignItems="center" gap={0}>
        <text fg={PURPLE} attributes={TextAttributes.BOLD}>
          {icon("ghost")}
        </text>

        <box height={compact ? 0 : 1} />

        {showWordmark ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable wordmark rows
          WORDMARK.map((line, i) => <GradientLine key={i} text={line} from={PURPLE} to={RED} />)
        ) : (
          <text fg={PURPLE} attributes={TextAttributes.BOLD}>
            SOULFORGE
          </text>
        )}

        <box flexDirection="row" gap={0}>
          <text fg={SUBTLE}>{"── "}</text>
          <text fg={MUTED} attributes={TextAttributes.ITALIC}>
            AI-Powered Terminal IDE
          </text>
          <text fg={SUBTLE}>{" ──"}</text>
        </box>

        <box height={compact ? 0 : 1} />
        <text fg={FAINT}>{"─".repeat(divW)}</text>
        <box height={compact ? 0 : 1} />

        <box flexDirection="row" gap={0} justifyContent="center" flexWrap="wrap">
          {visibleProviders.map((p, i) => (
            <box key={p.id} flexDirection="row" gap={0}>
              {i > 0 && <text fg={FAINT}>{" · "}</text>}
              <text fg={p.available ? GREEN : SUBTLE}>
                {providerIcon(p.id)} {p.name}
              </text>
            </box>
          ))}
          {providerOverflow > 0 && (
            <>
              <text fg={FAINT}>{" · "}</text>
              <text fg={SUBTLE}>+{providerOverflow}</text>
            </>
          )}
        </box>

        <box flexDirection="row" gap={0} justifyContent="center">
          {allToolsOk ? (
            <text fg={MUTED}>{icon("check")} all tools ready</text>
          ) : (
            bootPrereqs.map((t, i) => (
              <box key={t.prerequisite.name} flexDirection="row" gap={0}>
                {i > 0 && <text fg={FAINT}>{" · "}</text>}
                <text fg={t.installed ? GREEN : t.prerequisite.required ? RED : "#FF8C00"}>
                  {t.installed ? icon("check") : "○"} {t.prerequisite.name}
                </text>
              </box>
            ))
          )}
        </box>

        <IndexingStatus />

        {(missingRequired.length > 0 || !anyProvider) && (
          <text fg={SUBTLE}>/setup to configure</text>
        )}

        <box height={compact ? 0 : 1} />
        <text fg={FAINT}>{"─".repeat(divW)}</text>
        {!compact && <box height={1} />}

        <box flexDirection="row" gap={1} justifyContent="center" flexWrap="wrap">
          <Cmd name="help" />
          <Cmd name="open" arg="<file>" />
          <Cmd name="editor" />
          <Cmd name="skills" />
          <Cmd name="setup" />
          <Cmd name="models" />
        </box>

        <box height={compact ? 0 : 1} />
      </box>
    </box>
  );
}

function IndexingStatus() {
  const [state, setState] = useState(() => {
    const s = useRepoMapStore.getState();
    return { status: s.status, files: s.files, scanProgress: s.scanProgress };
  });
  const spinnerRef = useRef(0);
  const [tick, setTick] = useState(0);

  useEffect(
    () =>
      useRepoMapStore.subscribe((s) => {
        setState((prev) => {
          if (
            prev.status === s.status &&
            prev.files === s.files &&
            prev.scanProgress === s.scanProgress
          )
            return prev;
          return { status: s.status, files: s.files, scanProgress: s.scanProgress };
        });
      }),
    [],
  );

  useEffect(() => {
    if (state.status !== "scanning") return;
    const timer = setInterval(() => {
      spinnerRef.current++;
      setTick((t) => t + 1);
    }, 80);
    return () => clearInterval(timer);
  }, [state.status]);

  // Suppress unused var — tick drives re-renders for spinner animation
  void tick;

  const { status, files, scanProgress } = state;
  const frame = SPINNER_FRAMES[spinnerRef.current % SPINNER_FRAMES.length] ?? "⠋";

  if (status === "scanning") {
    const label = scanProgress || "indexing";
    return (
      <box flexDirection="row" gap={0} justifyContent="center">
        <text fg={AMBER}>
          {frame} indexing repo {label}
        </text>
      </box>
    );
  }

  if (status === "ready") {
    return (
      <box flexDirection="row" gap={0} justifyContent="center">
        <text fg={MUTED}>
          {icon("check")} {String(files)} files indexed
        </text>
      </box>
    );
  }

  if (status === "error") {
    return (
      <box flexDirection="row" gap={0} justifyContent="center">
        <text fg={RED}>○ indexing failed</text>
      </box>
    );
  }

  return null;
}

function Cmd({ name, arg }: { name: string; arg?: string }) {
  return (
    <box flexDirection="row" gap={0}>
      <text fg={RED}>/</text>
      <text fg="#777">{name}</text>
      {arg && <text fg={SUBTLE}> {arg}</text>}
    </box>
  );
}

function fitProviders(
  active: ProviderStatus[],
  inactive: ProviderStatus[],
  maxWidth: number,
): { visible: ProviderStatus[]; overflow: number } {
  const all = [...active, ...inactive];
  if (all.length === 0) return { visible: [], overflow: 0 };

  const visible: ProviderStatus[] = [];
  let usedWidth = 0;

  for (const p of all) {
    const entryWidth = (visible.length > 0 ? 3 : 0) + 2 + p.name.length;
    const overflowWidth = all.length - visible.length > 1 ? 5 : 0;

    if (usedWidth + entryWidth + overflowWidth > maxWidth && visible.length >= 3) {
      break;
    }
    visible.push(p);
    usedWidth += entryWidth;
  }

  return {
    visible,
    overflow: all.length - visible.length,
  };
}
