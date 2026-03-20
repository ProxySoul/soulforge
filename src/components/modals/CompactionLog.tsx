import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useState } from "react";
import { usePopupScroll } from "../../hooks/usePopupScroll.js";
import { useCompactionLogStore } from "../../stores/compaction-logs.js";
import { copyToClipboard } from "../../utils/clipboard.js";
import { timeAgo, truncLine } from "../../utils/time.js";
import { Overlay, POPUP_BG, POPUP_HL, PopupRow } from "../layout/shared.js";

const CHROME_ROWS = 7;

const KIND_ICONS: Record<string, { icon: string; color: string }> = {
  compact: { icon: "◆", color: "#9B30FF" },
  "strategy-change": { icon: "⇄", color: "#f80" },
  "auto-trigger": { icon: "⚡", color: "#2d5" },
  error: { icon: "✗", color: "#FF0040" },
};

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function CompactionLog({ visible, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [detailIndex, setDetailIndex] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [detailScrollOffset, setDetailScrollOffset] = useState(0);
  const { width: termCols, height: termRows } = useTerminalDimensions();
  const popupWidth = Math.max(60, Math.round(termCols * 0.8));
  const innerW = popupWidth - 2;
  const popupHeight = Math.max(12, Math.round(termRows * 0.7));
  const maxListVisible = Math.max(4, popupHeight - CHROME_ROWS);
  const maxDetailLines = Math.max(4, popupHeight - 6);
  const { cursor, setCursor, scrollOffset, adjustScroll, resetScroll } =
    usePopupScroll(maxListVisible);

  const entries = useCompactionLogStore((s) => s.entries);
  const sorted = useMemo(() => [...entries].sort((a, b) => b.timestamp - a.timestamp), [entries]);

  const filterQuery = query.toLowerCase().trim();
  const filtered = filterQuery
    ? sorted.filter(
        (e) =>
          e.kind.includes(filterQuery) ||
          e.message.toLowerCase().includes(filterQuery) ||
          (e.model?.toLowerCase().includes(filterQuery) ?? false) ||
          (e.summarySnippet?.toLowerCase().includes(filterQuery) ?? false),
      )
    : sorted;

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
    lines.push(`Kind: ${selectedEntry.kind}`);
    lines.push(`Time: ${new Date(selectedEntry.timestamp).toLocaleTimeString()}`);
    if (selectedEntry.model) lines.push(`Model: ${selectedEntry.model}`);
    if (selectedEntry.strategy) lines.push(`Strategy: ${selectedEntry.strategy}`);
    if (selectedEntry.contextBefore || selectedEntry.contextAfter) {
      lines.push(
        `Context: ${selectedEntry.contextBefore ?? "?"} → ${selectedEntry.contextAfter ?? "?"}`,
      );
    }
    if (selectedEntry.messagesBefore !== undefined || selectedEntry.messagesAfter !== undefined) {
      lines.push(
        `Messages: ${String(selectedEntry.messagesBefore ?? "?")} → ${String(selectedEntry.messagesAfter ?? "?")}`,
      );
    }
    if (selectedEntry.slotsBefore !== undefined) {
      lines.push(`V2 Slots: ${String(selectedEntry.slotsBefore)}`);
    }
    if (selectedEntry.summaryLength !== undefined) {
      lines.push(`Summary: ${String(selectedEntry.summaryLength)} chars`);
    }
    if (selectedEntry.summarySnippet) {
      lines.push("");
      lines.push("── Summary ──");
      lines.push(...selectedEntry.summarySnippet.split("\n"));
    }
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
          copyToClipboard(selectedEntry.summarySnippet ?? selectedEntry.message);
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
        copyToClipboard(entry.summarySnippet ?? entry.message);
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
    const kindInfo = KIND_ICONS[selectedEntry.kind] ?? { icon: "•", color: "#aaa" };

    return (
      <Overlay>
        <box
          flexDirection="column"
          borderStyle="rounded"
          border={true}
          borderColor="#336"
          width={popupWidth}
        >
          <PopupRow w={innerW}>
            <text fg={kindInfo.color} bg={POPUP_BG}>
              {kindInfo.icon}
            </text>
            <text fg="white" attributes={TextAttributes.BOLD} bg={POPUP_BG}>
              {" "}
              {selectedEntry.kind}
            </text>
            {selectedEntry.model && (
              <text fg="#9B30FF" bg={POPUP_BG}>
                {"  "}
                {selectedEntry.model}
              </text>
            )}
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
              {"─".repeat(innerW - 4)}
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
                const isSection = line.startsWith("──");
                return (
                  <PopupRow key={String(vi + detailScrollOffset)} w={innerW}>
                    <text
                      fg={isSection ? "#336" : "#aaa"}
                      attributes={isSection ? TextAttributes.BOLD : undefined}
                      bg={POPUP_BG}
                      truncate
                    >
                      {line.length > innerW - 4 ? `${line.slice(0, innerW - 5)}…` : line || " "}
                    </text>
                  </PopupRow>
                );
              })}
          </box>
          {detailLines.length > maxDetailLines && (
            <PopupRow w={innerW}>
              <text fg="#555" bg={POPUP_BG}>
                {detailScrollOffset > 0 ? "↑ " : "  "}
                {String(detailScrollOffset + 1)}-
                {String(Math.min(detailScrollOffset + maxDetailLines, detailLines.length))}/
                {String(detailLines.length)}
                {detailScrollOffset + maxDetailLines < detailLines.length ? " ↓" : ""}
              </text>
            </PopupRow>
          )}

          <PopupRow w={innerW}>
            <text>{""}</text>
          </PopupRow>

          <PopupRow w={innerW}>
            <text fg="#555" bg={POPUP_BG}>
              ↑↓ scroll | ^Y copy | esc back
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
        borderColor="#336"
        width={popupWidth}
      >
        <PopupRow w={innerW}>
          <text fg="#336" attributes={TextAttributes.BOLD} bg={POPUP_BG}>
            ◆ Compaction Log
          </text>
          <text fg="#555" bg={POPUP_BG}>
            {" "}
            ({String(entries.length)} {entries.length === 1 ? "event" : "events"})
          </text>
          {copied && (
            <text fg="#2d5" bg={POPUP_BG}>
              {"  "}Copied!
            </text>
          )}
        </PopupRow>

        <PopupRow w={innerW}>
          <text fg="#336" bg={POPUP_BG}>
            {" "}
          </text>
          {query ? (
            <>
              <text fg="white" bg={POPUP_BG}>
                {query}
              </text>
              <text fg="#336" bg={POPUP_BG}>
                █
              </text>
            </>
          ) : (
            <>
              <text fg="#336" bg={POPUP_BG}>
                █
              </text>
              <text fg="#555" bg={POPUP_BG}>
                type to filter...
              </text>
            </>
          )}
        </PopupRow>

        <PopupRow w={innerW}>
          <text fg="#333" bg={POPUP_BG}>
            {"─".repeat(innerW - 4)}
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
                {query ? "no matching events" : "no compaction events yet"}
              </text>
            </PopupRow>
          ) : (
            filtered.slice(scrollOffset, scrollOffset + maxListVisible).map((entry, vi) => {
              const i = vi + scrollOffset;
              const isActive = i === cursor;
              const bg = isActive ? POPUP_HL : POPUP_BG;
              const kindInfo = KIND_ICONS[entry.kind] ?? { icon: "•", color: "#aaa" };
              const kindLabel = entry.kind.padEnd(16);
              const timeStr = timeAgo(entry.timestamp);
              const modelStr = entry.model ? ` [${entry.model}]` : "";
              const summaryMax = innerW - 16 - timeStr.length - modelStr.length - 10;
              const summary = truncLine(entry.message, summaryMax);

              return (
                <PopupRow key={entry.id} bg={bg} w={innerW}>
                  <text bg={bg} fg={isActive ? "#336" : "#555"}>
                    {isActive ? "› " : "  "}
                  </text>
                  <text bg={bg} fg={kindInfo.color}>
                    {kindInfo.icon}{" "}
                  </text>
                  <text
                    bg={bg}
                    fg={isActive ? "white" : "#888"}
                    attributes={isActive ? TextAttributes.BOLD : undefined}
                  >
                    {kindLabel}
                  </text>
                  <text bg={bg} fg="#666">
                    {summary}
                  </text>
                  {modelStr && (
                    <text bg={bg} fg="#9B30FF">
                      {modelStr}
                    </text>
                  )}
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
              {scrollOffset > 0 ? "↑ " : "  "}
              {String(cursor + 1)}/{String(filtered.length)}
              {scrollOffset + maxListVisible < filtered.length ? " ↓" : ""}
            </text>
          </PopupRow>
        )}

        <PopupRow w={innerW}>
          <text>{""}</text>
        </PopupRow>

        <PopupRow w={innerW}>
          <text fg="#555" bg={POPUP_BG}>
            ↑↓ nav | ⏎ detail | ^Y copy summary | esc close
          </text>
        </PopupRow>
      </box>
    </Overlay>
  );
}
