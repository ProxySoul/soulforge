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
  lockIn = false,
}: {
  segments: StreamSegment[];
  toolCalls: LiveToolCall[];
  streaming?: boolean;
  verbose?: boolean;
  diffStyle?: "default" | "sidebyside" | "compact";
  showReasoning?: boolean;
  reasoningExpanded?: boolean;
  lockIn?: boolean;
}) {
  const toolCallMap = useMemo(() => new Map(toolCalls.map((tc) => [tc.id, tc])), [toolCalls]);

  // Merge consecutive tool segments (skipping empty text between them) so they share one tree
  const merged = useMemo(() => {
    const out: StreamSegment[] = [];
    for (const seg of segments) {
      if (seg.type === "text" && seg.content.trim() === "") continue;
      const prev = out[out.length - 1];
      if (seg.type === "tools" && prev?.type === "tools") {
        prev.callIds.push(...seg.callIds);
      } else {
        out.push(seg.type === "tools" ? { type: "tools", callIds: [...seg.callIds] } : seg);
      }
    }
    return out;
  }, [segments]);

  const lastTextIndex = useMemo(() => {
    if (!streaming) return -1;
    for (let j = merged.length - 1; j >= 0; j--) {
      if (merged[j]?.type === "text") return j;
    }
    return -1;
  }, [merged, streaming]);

  let lastVisibleType: string | null = null;
  return (
    <>
      {merged.map((seg, i) => {
        if (seg.type === "reasoning" && !showReasoning) return null;

        const needsGap = lastVisibleType !== null && lastVisibleType !== seg.type ? 1 : 0;
        if (seg.type === "text") {
          // Lock-in mode: suppress all text during streaming.
          // Final answer appears when the message goes static.
          if (lockIn) return null;
          lastVisibleType = seg.type;
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
          lastVisibleType = seg.type;
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
        // Lock-in mode: tools rendered by LockInWrapper, skip here
        if (lockIn) return null;
        const calls = seg.callIds
          .map((id: string) => toolCallMap.get(id))
          .filter((tc): tc is LiveToolCall => tc != null);
        if (calls.length === 0) return null;
        lastVisibleType = seg.type;
        return (
          <box key={seg.callIds[0]} marginTop={needsGap}>
            <ToolCallDisplay
              calls={calls}
              allCalls={toolCalls}
              verbose={verbose}
              diffStyle={diffStyle}
            />
          </box>
        );
      })}
    </>
  );
});
