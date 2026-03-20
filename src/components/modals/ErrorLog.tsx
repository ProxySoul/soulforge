import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useState } from "react";
import { usePopupScroll } from "../../hooks/usePopupScroll.js";
import { useErrorStore } from "../../stores/errors.js";
import type { ChatMessage } from "../../types/index.js";
import { copyToClipboard } from "../../utils/clipboard.js";
import { timeAgo, truncLine } from "../../utils/time.js";
import { Overlay, POPUP_BG, POPUP_HL, PopupRow } from "../layout/shared.js";

const CHROME_ROWS = 7;

type LogEntryKind = "tool-ok" | "tool-error" | "request-error";

interface LogEntry {
  id: string;
  kind: LogEntryKind;
  name: string;
  timestamp: number;
  summary: string;
  detail: string;
  args?: string;
}

function isErrorSystemMsg(content: string): boolean {
  return (
    content.startsWith("Error:") ||
    content.startsWith("Request failed:") ||
    content.startsWith("Failed")
  );
}

function stripErrorPrefix(content: string): string {
  if (content.startsWith("Error: ")) return content.slice(7);
  if (content.startsWith("Request failed: ")) return content.slice(16);
  return content;
}

function extractLogEntries(messages: ChatMessage[]): LogEntry[] {
  const entries: LogEntry[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant" && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        const success = tc.result?.success ?? false;
        const output = success
          ? (tc.result?.output ?? "")
          : (tc.result?.error ?? tc.result?.output ?? "");
        entries.push({
          id: tc.id,
          kind: success ? "tool-ok" : "tool-error",
          name: tc.name,
          timestamp: msg.timestamp,
          summary: truncLine(output, 80),
          detail: output,
          args: JSON.stringify(tc.args, null, 2),
        });
      }
    }

    if (msg.role === "system" && isErrorSystemMsg(msg.content)) {
      entries.push({
        id: `req-${String(msg.timestamp)}`,
        kind: "request-error",
        name: "Request Error",
        timestamp: msg.timestamp,
        summary: truncLine(stripErrorPrefix(msg.content), 80),
        detail: msg.content,
      });
    }
  }

  return entries.reverse();
}

interface Props {
  visible: boolean;
  messages: ChatMessage[];
  onClose: () => void;
}

export function ErrorLog({ visible, messages, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [detailIndex, setDetailIndex] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [detailScrollOffset, setDetailScrollOffset] = useState(0);
  const { width: termCols, height: termRows } = useTerminalDimensions();
  const popupWidth = Math.max(60, Math.round(termCols * 0.8));
  const innerW = popupWidth - 2;
  const popupHeight = Math.max(12, Math.round(termRows * 0.5));
  const maxListVisible = Math.max(4, popupHeight - CHROME_ROWS);
  const maxDetailLines = Math.max(4, popupHeight - 6);
  const { cursor, setCursor, scrollOffset, adjustScroll, resetScroll } =
    usePopupScroll(maxListVisible);

  const bgErrors = useErrorStore((s) => s.errors);
  const entries = useMemo(() => {
    const chatEntries = extractLogEntries(messages);
    const bgEntries: LogEntry[] = bgErrors.map((e) => ({
      id: e.id,
      kind: "request-error" as const,
      name: e.source,
      timestamp: e.timestamp,
      summary: truncLine(e.message, 80),
      detail: e.message,
    }));
    return [...chatEntries, ...bgEntries].sort((a, b) => b.timestamp - a.timestamp);
  }, [messages, bgErrors]);

  const errorEntries = useMemo(() => entries.filter((e) => e.kind !== "tool-ok"), [entries]);

  const filterQuery = query.toLowerCase().trim();
  const filtered = filterQuery
    ? errorEntries.filter(
        (e) =>
          e.name.toLowerCase().includes(filterQuery) ||
          e.summary.toLowerCase().includes(filterQuery) ||
          e.detail.toLowerCase().includes(filterQuery),
      )
    : errorEntries;

  useEffect(() => {
    if (visible) {
      setQuery("");
      resetScroll();
      setDetailScrollOffset(0);
      setDetailIndex(null);
      setCopied(false);
    }
  }, [visible, resetScroll]);

  const showCopied = () => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const inDetail = detailIndex !== null;
  const selectedEntry = inDetail ? filtered[detailIndex] : null;

  const detailLines = useMemo(() => {
    if (!selectedEntry) return [];
    const lines: string[] = [];
    if (selectedEntry.args) {
      lines.push("── Args ──");
      lines.push(...selectedEntry.args.split("\n"));
      lines.push("");
    }
    const sectionLabel = selectedEntry.kind === "tool-ok" ? "── Output ──" : "── Error ──";
    lines.push(sectionLabel);
    lines.push(...selectedEntry.detail.split("\n"));
    return lines;
  }, [selectedEntry]);

  useKeyboard((evt) => {
    if (!visible) return;

    if (inDetail) {
      if (evt.name === "escape") {
        setDetailIndex(null);
        setDetailScrollOffset(0);
        return;
      }
      if (evt.name === "up") {
        setDetailScrollOffset((prev) => Math.max(0, prev - 1));
        return;
      }
      if (evt.name === "down") {
        setDetailScrollOffset((prev) =>
          Math.min(Math.max(0, detailLines.length - maxDetailLines), prev + 1),
        );
        return;
      }
      if (evt.name === "y" && evt.ctrl) {
        if (selectedEntry) {
          const text = selectedEntry.args
            ? `Args:\n${selectedEntry.args}\n\n${selectedEntry.detail}`
            : selectedEntry.detail;
          copyToClipboard(text);
          showCopied();
        }
        return;
      }
      return;
    }

    if (evt.name === "escape") {
      onClose();
      return;
    }

    if (evt.name === "up") {
      setCursor((prev) => {
        const next = prev > 0 ? prev - 1 : Math.max(0, filtered.length - 1);
        adjustScroll(next);
        return next;
      });
      return;
    }
    if (evt.name === "down") {
      setCursor((prev) => {
        const next = prev < filtered.length - 1 ? prev + 1 : 0;
        adjustScroll(next);
        return next;
      });
      return;
    }

    if (evt.name === "return") {
      if (filtered[cursor]) {
        setDetailIndex(cursor);
      }
      return;
    }

    if (evt.name === "y" && evt.ctrl) {
      const entry = filtered[cursor];
      if (entry) {
        const text = entry.args ? `Args:\n${entry.args}\n\n${entry.detail}` : entry.detail;
        copyToClipboard(text);
        showCopied();
      }
      return;
    }

    if (evt.name === "backspace" || evt.name === "delete") {
      setQuery((prev) => prev.slice(0, -1));
      resetScroll();
      return;
    }

    if (evt.name && evt.name.length === 1 && !evt.ctrl && !evt.meta) {
      setQuery((prev) => prev + evt.name);
      resetScroll();
    }
  });

  if (!visible) return null;

  if (inDetail && selectedEntry) {
    const statusIcon = selectedEntry.kind === "tool-ok" ? "\u2713" : "\u2717";
    const statusColor = selectedEntry.kind === "tool-ok" ? "#2d5" : "#FF0040";

    return (
      <Overlay>
        <box
          flexDirection="column"
          borderStyle="rounded"
          border={true}
          borderColor="#8B5CF6"
          width={popupWidth}
        >
          <PopupRow w={innerW}>
            <text fg={statusColor} bg={POPUP_BG}>
              {statusIcon}
            </text>
            <text fg="white" attributes={TextAttributes.BOLD} bg={POPUP_BG}>
              {" "}
              {selectedEntry.name}
            </text>
            <text fg="#555" bg={POPUP_BG}>
              {"  "}
              {timeAgo(selectedEntry.timestamp)}
            </text>
            {copied && (
              <text fg="#2d5" bg={POPUP_BG}>
                {"  "}Copied!
              </text>
            )}
          </PopupRow>

          <PopupRow w={innerW}>
            <text fg="#333" bg={POPUP_BG}>
              {"\u2500".repeat(innerW - 4)}
            </text>
          </PopupRow>

          <box
            flexDirection="column"
            height={Math.min(detailLines.length, maxDetailLines)}
            overflow="hidden"
          >
            {detailLines
              .slice(detailScrollOffset, detailScrollOffset + maxDetailLines)
              .map((line, vi) => {
                const isSection = line.startsWith("\u2500\u2500");
                return (
                  <PopupRow key={String(vi + detailScrollOffset)} w={innerW}>
                    <text
                      fg={isSection ? "#8B5CF6" : "#aaa"}
                      attributes={isSection ? TextAttributes.BOLD : undefined}
                      bg={POPUP_BG}
                      truncate
                    >
                      {line.length > innerW - 4
                        ? `${line.slice(0, innerW - 5)}\u2026`
                        : line || " "}
                    </text>
                  </PopupRow>
                );
              })}
          </box>
          {detailLines.length > maxDetailLines && (
            <PopupRow w={innerW}>
              <text fg="#555" bg={POPUP_BG}>
                {detailScrollOffset > 0 ? "\u2191 " : "  "}
                {String(detailScrollOffset + 1)}-
                {String(Math.min(detailScrollOffset + maxDetailLines, detailLines.length))}/
                {String(detailLines.length)}
                {detailScrollOffset + maxDetailLines < detailLines.length ? " \u2193" : ""}
              </text>
            </PopupRow>
          )}

          <PopupRow w={innerW}>
            <text>{""}</text>
          </PopupRow>

          <PopupRow w={innerW}>
            <text fg="#555" bg={POPUP_BG}>
              {"\u2191\u2193"} scroll | ^Y copy | esc back
            </text>
          </PopupRow>
        </box>
      </Overlay>
    );
  }

  return (
    <Overlay>
      <box
        flexDirection="column"
        borderStyle="rounded"
        border={true}
        borderColor="#8B5CF6"
        width={popupWidth}
      >
        <PopupRow w={innerW}>
          <text fg="white" attributes={TextAttributes.BOLD} bg={POPUP_BG}>
            {"\uF06A"} Error Log
          </text>
          <text fg="#555" bg={POPUP_BG}>
            {" "}
            ({String(errorEntries.length)} {errorEntries.length === 1 ? "error" : "errors"})
          </text>
          {copied && (
            <text fg="#2d5" bg={POPUP_BG}>
              {"  "}Copied!
            </text>
          )}
        </PopupRow>

        <PopupRow w={innerW}>
          <text fg="#9B30FF" bg={POPUP_BG}>
            {" "}
          </text>
          {query ? (
            <>
              <text fg="white" bg={POPUP_BG}>
                {query}
              </text>
              <text fg="#FF0040" bg={POPUP_BG}>
                {"\u2588"}
              </text>
            </>
          ) : (
            <>
              <text fg="#FF0040" bg={POPUP_BG}>
                {"\u2588"}
              </text>
              <text fg="#555" bg={POPUP_BG}>
                type to filter errors...
              </text>
            </>
          )}
        </PopupRow>

        <PopupRow w={innerW}>
          <text fg="#333" bg={POPUP_BG}>
            {"\u2500".repeat(innerW - 4)}
          </text>
        </PopupRow>

        <box
          flexDirection="column"
          height={Math.min(filtered.length || 1, maxListVisible)}
          overflow="hidden"
        >
          {filtered.length === 0 ? (
            <PopupRow w={innerW}>
              <text fg="#555" bg={POPUP_BG}>
                {query ? "no matching errors" : "no errors yet"}
              </text>
            </PopupRow>
          ) : (
            filtered.slice(scrollOffset, scrollOffset + maxListVisible).map((entry, vi) => {
              const i = vi + scrollOffset;
              const isActive = i === cursor;
              const bg = isActive ? POPUP_HL : POPUP_BG;
              const statusColor = entry.kind === "request-error" ? "#FF0040" : "#f80";
              const nameMax = 20;
              const timeStr = timeAgo(entry.timestamp);
              const summaryMax = innerW - nameMax - timeStr.length - 10;
              const name =
                entry.name.length > nameMax
                  ? `${entry.name.slice(0, nameMax - 1)}\u2026`
                  : entry.name.padEnd(nameMax);
              const summary = truncLine(entry.summary, summaryMax);

              return (
                <PopupRow key={entry.id} bg={bg} w={innerW}>
                  <text bg={bg} fg={isActive ? "#FF0040" : "#555"}>
                    {isActive ? "\u203A " : "  "}
                  </text>
                  <text bg={bg} fg={statusColor}>
                    {"\u2717"}{" "}
                  </text>
                  <text
                    bg={bg}
                    fg={isActive ? "white" : "#aaa"}
                    attributes={isActive ? TextAttributes.BOLD : undefined}
                  >
                    {name}
                  </text>
                  <text bg={bg} fg="#666">
                    {" "}
                    {summary}
                  </text>
                  <text bg={bg} fg="#444">
                    {"  "}
                    {timeStr}
                  </text>
                </PopupRow>
              );
            })
          )}
        </box>
        {filtered.length > maxListVisible && (
          <PopupRow w={innerW}>
            <text fg="#555" bg={POPUP_BG}>
              {scrollOffset > 0 ? "\u2191 " : "  "}
              {String(cursor + 1)}/{String(filtered.length)}
              {scrollOffset + maxListVisible < filtered.length ? " \u2193" : ""}
            </text>
          </PopupRow>
        )}

        <PopupRow w={innerW}>
          <text>{""}</text>
        </PopupRow>

        <PopupRow w={innerW}>
          <text fg="#555" bg={POPUP_BG}>
            {"\u2191\u2193"} nav | {"\u23CE"} detail | ^Y copy | esc close
          </text>
        </PopupRow>
      </box>
    </Overlay>
  );
}
