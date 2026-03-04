import { Box, Text } from "ink";
import { useEffect, useState } from "react";

const BRAIN_ICON = "󰘦"; // nf-md-head_cog U+F0626
const DIMMED = "#555";
const RAIL_COLOR = "#444";

interface Props {
  content: string;
  expanded: boolean;
  isStreaming?: boolean;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function ThinkingSpinner() {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  return (
    <Text color="#8B5CF6" bold>
      {SPINNER[frame]}
    </Text>
  );
}

export function ReasoningBlock({ content, expanded, isStreaming }: Props) {
  const lineCount = content.split("\n").length;

  // While streaming: show wrapped block with spinner
  if (isStreaming) {
    if (!expanded) {
      return (
        <Box height={1} flexShrink={0}>
          <Text color={RAIL_COLOR}>│ </Text>
          <ThinkingSpinner />
          <Text color={DIMMED}> {BRAIN_ICON} reasoning</Text>
          {lineCount > 1 && <Text color="#444"> ({String(lineCount)} lines)</Text>}
        </Box>
      );
    }

    // Streaming + expanded: show live content in wrapped block
    const lines = content.split("\n");
    const maxLines = 6;
    const visible = lines.slice(-maxLines);
    return (
      <Box flexDirection="column">
        <Box height={1} flexShrink={0}>
          <Text color={RAIL_COLOR}>│ </Text>
          <ThinkingSpinner />
          <Text color={DIMMED}> {BRAIN_ICON} reasoning</Text>
        </Box>
        {visible.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable line order
          <Box key={i}>
            <Text color={RAIL_COLOR}>│ </Text>
            <Text color="#555">{line}</Text>
          </Box>
        ))}
        {lines.length > maxLines && (
          <Box>
            <Text color={RAIL_COLOR}>│ </Text>
            <Text color="#444">...{String(lines.length - maxLines)} more</Text>
          </Box>
        )}
      </Box>
    );
  }

  // Finished: collapsed one-liner summary
  const firstLine = (content.split("\n")[0] ?? "").trim();
  const preview = firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;

  return (
    <Box height={1} flexShrink={0}>
      <Text color={DIMMED} wrap="truncate">
        <Text color="#2d5">✓</Text> {BRAIN_ICON} <Text color="#666">{preview || "Reasoned"}</Text>
        {lineCount > 1 && <Text color="#444"> ({String(lineCount)} lines)</Text>}
      </Text>
    </Box>
  );
}
