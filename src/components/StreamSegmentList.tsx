import { memo, useMemo } from "react";
import { Markdown } from "./Markdown.js";
import { ReasoningBlock } from "./ReasoningBlock.js";
import { type LiveToolCall, ToolCallDisplay } from "./ToolCallDisplay.js";

type StreamSegment =
  | { type: "text"; content: string }
  | { type: "tools"; callIds: string[] }
  | { type: "reasoning"; content: string; id: string; done?: boolean };

export type { StreamSegment };

function trimToCompleteLines(text: string): string {
  return text;
}

const STREAMING_OPACITY = 0.7;

export const StreamSegmentList = memo(function StreamSegmentList({
  segments,
  toolCalls,
  streaming = false,
  verbose = false,
  diffStyle = "default",
  showReasoning = true,
  reasoningExpanded = false,
}: {
  segments: StreamSegment[];
  toolCalls: LiveToolCall[];
  streaming?: boolean;
  verbose?: boolean;
  diffStyle?: "default" | "sidebyside" | "compact";
  showReasoning?: boolean;
  reasoningExpanded?: boolean;
}) {
  const toolCallMap = useMemo(() => new Map(toolCalls.map((tc) => [tc.id, tc])), [toolCalls]);

  let lastTextIndex = -1;
  if (streaming) {
    for (let j = segments.length - 1; j >= 0; j--) {
      if (segments[j]?.type === "text") {
        lastTextIndex = j;
        break;
      }
    }
  }

  let lastVisibleType: string | null = null;
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === "reasoning" && !showReasoning) return null;

        const needsGap = lastVisibleType !== null && lastVisibleType !== seg.type ? 1 : 0;
        lastVisibleType = seg.type;
        if (seg.type === "text") {
          const isActiveSegment = i === lastTextIndex;
          const display = trimToCompleteLines(seg.content);
          if (display.length === 0) return null;
          return (
            <box
              key={`text-${String(i)}`}
              flexDirection="column"
              marginTop={needsGap}
              opacity={isActiveSegment ? STREAMING_OPACITY : undefined}
            >
              <Markdown text={isActiveSegment ? `${display}▊` : display} streaming />
            </box>
          );
        }
        if (seg.type === "reasoning") {
          const rKey = `${seg.id}-${reasoningExpanded ? "exp" : "col"}`;
          return (
            <box key={rKey} marginTop={needsGap}>
              <ReasoningBlock
                content={seg.content}
                expanded={reasoningExpanded}
                isStreaming={!seg.done}
              />
            </box>
          );
        }
        const calls = seg.callIds
          .map((id: string) => toolCallMap.get(id))
          .filter((tc): tc is LiveToolCall => tc != null);
        if (calls.length === 0) return null;
        return (
          <box key={seg.callIds[0]} marginTop={needsGap}>
            <ToolCallDisplay calls={calls} verbose={verbose} diffStyle={diffStyle} />
          </box>
        );
      })}
    </>
  );
});
