import { icon } from "../../core/icons.js";
import { SPINNER_FRAMES, useSpinnerFrame } from "../layout/shared.js";

const brainIcon = () => icon("brain");
const BORDER = "#333";
const BORDER_ACTIVE = "#3a3050";
const TEXT_COLOR = "#888";
const MUTED = "#333";
const DIMMED = "#3a3a3a";

interface Props {
  content: string;
  expanded: boolean;
  isStreaming?: boolean;
  id: string;
}

function ThinkingSpinner() {
  const frame = useSpinnerFrame();
  return <text fg="#5a4a70">{SPINNER_FRAMES[frame]}</text>;
}

export function ReasoningBlock({ content, expanded, isStreaming, id }: Props) {
  const lines = content.split("\n");
  const lineCount = lines.length;

  if (!expanded) {
    if (isStreaming) {
      return (
        <box key={`${id}-col`} height={1} flexShrink={0} flexDirection="row">
          <ThinkingSpinner />
          <text fg={DIMMED}> {brainIcon()} reasoning</text>
          {lineCount > 1 && <text fg={MUTED}> ({String(lineCount)} lines)</text>}
          <text fg="#2a2a2a"> ^O</text>
        </box>
      );
    }
    const firstLine = (lines[0] ?? "").trim();
    const preview = firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
    return (
      <box key={`${id}-col`} height={1} flexShrink={0}>
        <text fg={DIMMED} truncate>
          <span fg="#1a5">✓</span> {brainIcon()} <span fg={DIMMED}>{preview || "Reasoned"}</span>
          {lineCount > 1 && <span fg={MUTED}> ({String(lineCount)} lines)</span>}
          <span fg="#333"> ^O</span>
        </text>
      </box>
    );
  }

  const bc = isStreaming ? BORDER_ACTIVE : BORDER;
  const label = isStreaming ? "reasoning…" : "reasoning";
  const trimmed = content.trim();

  return (
    <box
      key={`${id}-exp`}
      flexDirection="column"
      flexShrink={0}
      border
      borderStyle="rounded"
      borderColor={bc}
    >
      <box
        height={1}
        flexShrink={0}
        paddingX={1}
        backgroundColor="#1a1a1a"
        alignSelf="flex-start"
        marginTop={-1}
      >
        <text truncate>
          <span fg="#5a4a70">{brainIcon()}</span> <span fg="#6a5a80">{label}</span>
          <span fg="#333"> ^O</span>
        </text>
      </box>
      <box flexDirection="column" paddingX={1}>
        {trimmed.split("\n").map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static split lines don't reorder
          <text key={i} fg={TEXT_COLOR}>
            {line}
          </text>
        ))}
      </box>
    </box>
  );
}
