import { memo, useMemo } from "react";
import { Markdown } from "./Markdown.js";
import { ReasoningBlock } from "./ReasoningBlock.js";
import { type LiveToolCall, ToolCallDisplay } from "./ToolCallDisplay.js";
import { useTextDrip } from "./useTextDrip.js";

type StreamSegment =
  | { type: "text"; content: string }
  | { type: "tools"; callIds: string[] }
  | { type: "reasoning"; content: string; id: string; done?: boolean };

export type { StreamSegment };

function trimToCompleteLines(text: string): string {
  return text;
}

const STREAM_OPACITY = 0.65;

/** Wrapper that applies the drip buffer to the active streaming text. */
function DripText({ content, streaming }: { content: string; streaming: boolean }) {
  const { text: display } = useTextDrip(content, streaming);

  if (display.length === 0) return null;

  return (
    <box flexDirection="column" opacity={STREAM_OPACITY}>
      <Markdown text={`${display}▊`} streaming />
    </box>
  );
}

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

  const lastTextIndex = useMemo(() => {
    if (!streaming) return -1;
    for (let j = segments.length - 1; j >= 0; j--) {
      if (segments[j]?.type === "text") return j;
    }
    return -1;
  }, [segments, streaming]);

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
          if (isActiveSegment) {
            return (
              <box key={`text-${String(i)}`} flexDirection="column" marginTop={needsGap}>
                <DripText content={display} streaming={streaming} />
              </box>
            );
          }
          return (
            <box key={`text-${String(i)}`} flexDirection="column" marginTop={needsGap}>
              <Markdown text={display} streaming />
            </box>
          );
        }
        if (seg.type === "reasoning") {
          const rkey = `${seg.id}-${reasoningExpanded ? "exp" : "col"}`;
          return (
            <box key={rkey} flexDirection="column" marginTop={needsGap}>
              <ReasoningBlock
                content={seg.content}
                expanded={reasoningExpanded}
                isStreaming={!seg.done}
                id={seg.id}
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
