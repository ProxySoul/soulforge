import { useEffect, useMemo, useRef, useState } from "react";
import { icon } from "../../core/icons.js";
import { useTheme } from "../../core/theme/index.js";
import { Spinner } from "../layout/shared.js";
import { Markdown } from "./Markdown.js";

const brainIcon = () => icon("brain");

interface Props {
  content: string;
  expanded: boolean;
  isStreaming?: boolean;
  id: string;
}

function ThinkingSpinner() {
  const t = useTheme();
  return <Spinner color={t.brandDim} />;
}

export function ReasoningBlock({ content, expanded, isStreaming, id }: Props) {
  const t = useTheme();

  const lineCount = useMemo(() => {
    let n = 1;
    for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) n++;
    return n;
  }, [content]);

  // Throttle the body content during streaming so tree-sitter doesn't re-parse
  // a multi-thousand-line blob on every 16-32ms flush. Static (non-streaming)
  // content updates immediately. We read latest via ref to avoid restarting
  // the timer on every prop change.
  const latestRef = useRef(content);
  latestRef.current = content;
  const [throttled, setThrottled] = useState(content);
  useEffect(() => {
    if (!isStreaming) {
      setThrottled(latestRef.current);
      return;
    }
    const tick = () => {
      setThrottled((prev) => (prev === latestRef.current ? prev : latestRef.current));
    };
    tick();
    const timer = setInterval(tick, 150);
    return () => clearInterval(timer);
  }, [isStreaming]);

  // While streaming, render only the tail of very long reasoning so tree-sitter
  // re-parse cost stays bounded regardless of total length. Final (non-streaming)
  // render shows the full blob.
  const display = useMemo(() => {
    const src = isStreaming ? throttled : content;
    if (!isStreaming) return src.trim();
    if (src.length <= STREAM_TAIL_CHARS) return src.trim();
    const sliced = src.slice(-STREAM_TAIL_CHARS);
    const firstNl = sliced.indexOf("\n");
    return firstNl > 0 ? sliced.slice(firstNl + 1).trim() : sliced.trim();
  }, [isStreaming, throttled, content]);

  const shownLines = useMemo(() => {
    if (!isStreaming) return lineCount;
    let n = 1;
    for (let i = 0; i < display.length; i++) if (display.charCodeAt(i) === 10) n++;
    return n;
  }, [isStreaming, display, lineCount]);

  if (!expanded) {
    if (isStreaming) {
      return (
        <box key={`${id}-col`} height={1} flexShrink={0} flexDirection="row">
          <ThinkingSpinner />
          <text fg={t.textFaint}> {brainIcon()} reasoning</text>
          {lineCount > 1 && <text fg={t.textFaint}> ({String(lineCount)} lines)</text>}
          <text fg={t.textSubtle}> ^O</text>
        </box>
      );
    }
    const nl = content.indexOf("\n");
    const firstLineRaw = nl >= 0 ? content.slice(0, nl) : content;
    const firstLine = firstLineRaw.trim().replace(/\*\*/g, "");
    const preview = firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
    return (
      <box key={`${id}-col`} height={1} flexShrink={0}>
        <text fg={t.textFaint} truncate>
          <span fg={t.success}>✓</span> {brainIcon()}{" "}
          <span fg={t.textFaint}>{preview || "Reasoned"}</span>
          {lineCount > 1 && <span fg={t.textFaint}> ({String(lineCount)} lines)</span>}
          <span fg={t.textFaint}> ^O</span>
        </text>
      </box>
    );
  }

  const bc = isStreaming ? t.brandDim : t.border;
  const label = isStreaming ? "reasoning…" : "reasoning";
  const truncated = isStreaming && shownLines < lineCount;

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
        backgroundColor={t.bgElevated}
        alignSelf="flex-start"
        marginTop={-1}
      >
        <text truncate>
          <span fg={t.brandDim}>{brainIcon()}</span> <span fg={t.brandDim}>{label}</span>
          {truncated ? <span fg={t.textFaint}> · tail of {String(lineCount)} lines</span> : null}
          <span fg={t.textFaint}> ^O</span>
        </text>
      </box>
      <box flexDirection="column" paddingX={1}>
        <Markdown text={display} streaming={isStreaming} />
      </box>
    </box>
  );
}
const STREAM_TAIL_CHARS = 4096;
