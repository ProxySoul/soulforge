import { memo, useMemo, useRef } from "react";
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

/** Wrapper that applies the drip buffer to the active streaming text. */
function DripText({ content, streaming }: { content: string; streaming: boolean }) {
  const { text: display, opacity } = useTextDrip(content, streaming);

  if (display.length === 0) return null;

  const cursor = streaming ? "▊" : "";

  return (
    <box flexDirection="column" opacity={opacity}>
      <Markdown text={`${display}${cursor}`} streaming />
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
  // Build a stable id->call lookup. Allocating a new Map each render costs O(N)
  // but avoids the O(N²) of repeated linear lookups inside the render loop.
  const toolCallMap = useMemo(() => {
    const m = new Map<string, LiveToolCall>();
    for (const tc of toolCalls) m.set(tc.id, tc);
    return m;
  }, [toolCalls]);

  // Prefix-stable merge cache: each render compares the new segments array
  // against the previous one element-by-element and reuses the merged tail
  // from cache if the prefix is identical (which is the common case during
  // streaming — only the trailing segment grows).
  const mergeCacheRef = useRef<{ in: StreamSegment[]; out: StreamSegment[] }>({
    in: [],
    out: [],
  });
  const merged = useMemo(() => {
    const cache = mergeCacheRef.current;
    // If new segments is a strict prefix of cached input AND nothing in the
    // shared prefix changed, we can reuse cache.out wholesale up to that point.
    let sharedPrefix = 0;
    while (
      sharedPrefix < segments.length &&
      sharedPrefix < cache.in.length &&
      segments[sharedPrefix] === cache.in[sharedPrefix]
    ) {
      sharedPrefix++;
    }
    const out: StreamSegment[] = [];
    if (sharedPrefix > 0) {
      // Find how many merged-output entries correspond to the shared input
      // prefix. We can't simply slice because tool-segment merging changes
      // the count. Walk the input prefix and replay merging into `out`.
      for (let i = 0; i < sharedPrefix; i++) {
        const seg = cache.in[i] as StreamSegment;
        if (seg.type === "text" && seg.content.trim() === "") continue;
        const prev = out[out.length - 1];
        if (seg.type === "tools" && prev?.type === "tools") {
          out[out.length - 1] = {
            type: "tools",
            callIds: [...prev.callIds, ...seg.callIds],
          };
        } else {
          out.push(seg.type === "tools" ? { type: "tools", callIds: [...seg.callIds] } : seg);
        }
      }
    }
    // Process the changed tail.
    for (let i = sharedPrefix; i < segments.length; i++) {
      const seg = segments[i] as StreamSegment;
      if (seg.type === "text" && seg.content.trim() === "") continue;
      const prev = out[out.length - 1];
      if (seg.type === "tools" && prev?.type === "tools") {
        out[out.length - 1] = {
          type: "tools",
          callIds: [...prev.callIds, ...seg.callIds],
        };
      } else {
        out.push(seg.type === "tools" ? { type: "tools", callIds: [...seg.callIds] } : seg);
      }
    }
    mergeCacheRef.current = { in: segments, out };
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
