/**
 * LogViewer — generic scrollable log with master/detail mode.
 *
 * Callers (ErrorLog, CompactionLog) provide a `LogViewerConfig` that
 * describes rendering + filter + copy behavior. This wrapper renders
 * list and detail views using shared primitives.
 */

import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "../../core/theme/index.js";
import { copyToClipboard } from "../../utils/clipboard.js";
import {
  handleCursorNavKey,
  handleTextInputKey,
  PremiumPopup,
  Search,
  Section,
  VSpacer,
} from "../ui/index.js";

export interface LogViewerEntry {
  id: string;
  timestamp: number;
}

interface DetailHeader {
  icon: string;
  iconColor: string;
  label: string;
  sublabel?: string;
  sublabelColor?: string;
  timeStr: string;
}

export interface LogViewerConfig<T extends LogViewerEntry> {
  title: string;
  titleIcon: string;
  titleColor: string;
  borderColor: string;
  accentColor: string;
  cursorColor: string;
  heightRatio?: number;
  emptyMessage: string;
  emptyFilterMessage: string;
  filterPlaceholder: string;
  countLabel: (n: number) => string;
  filterFn: (entry: T, query: string) => boolean;
  renderListRow: (
    entry: T,
    innerW: number,
  ) => {
    icon: string;
    iconColor: string;
    label: string;
    summary: string;
    extra?: string;
    extraColor?: string;
    timeStr: string;
  };
  getDetailHeader: (entry: T) => DetailHeader;
  getDetailLines: (entry: T) => string[];
  getCopyText: (entry: T) => string;
  detailSectionColor?: string;
}

interface Props<T extends LogViewerEntry> {
  visible: boolean;
  onClose: () => void;
  entries: T[];
  config: LogViewerConfig<T>;
}

const BOLD = 1;

export function LogViewer<T extends LogViewerEntry>({
  visible,
  onClose,
  entries,
  config,
}: Props<T>) {
  const t = useTheme();
  const { width: tw, height: th } = useTerminalDimensions();

  const popupW = Math.min(120, Math.max(72, Math.floor(tw * 0.85)));
  const popupH = Math.min(Math.max(16, Math.floor(th * (config.heightRatio ?? 0.75))), th - 4);
  const contentW = popupW - 4;
  const listRows = Math.max(4, popupH - 11);
  const detailRows = Math.max(4, popupH - 9);

  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [detailIdx, setDetailIdx] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const cursorRef = useRef(0);
  cursorRef.current = cursor;
  const listScrollRef = useRef<ScrollBoxRenderable>(null);
  const detailScrollRef = useRef<ScrollBoxRenderable>(null);
  const listOffset = useRef(0);
  const detailOffset = useRef(0);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    return q ? entries.filter((e) => config.filterFn(e, q)) : entries;
  }, [entries, query, config]);

  useEffect(() => {
    if (!visible) return;
    setQuery("");
    setCursor(0);
    setDetailIdx(null);
    setCopied(false);
    listOffset.current = 0;
    detailOffset.current = 0;
    listScrollRef.current?.scrollTo(0);
  }, [visible]);

  // Clamp cursor when filter narrows
  useEffect(() => {
    if (cursor >= filtered.length && filtered.length > 0) setCursor(filtered.length - 1);
  }, [filtered.length, cursor]);

  // Keep list cursor visible
  useEffect(() => {
    if (cursor < 0 || filtered.length === 0) return;
    const o = listOffset.current;
    if (cursor < o) {
      listOffset.current = cursor;
      listScrollRef.current?.scrollTo(cursor);
    } else if (cursor >= o + listRows) {
      const n = cursor - listRows + 1;
      listOffset.current = n;
      listScrollRef.current?.scrollTo(n);
    }
  }, [cursor, filtered.length, listRows]);

  const inDetail = detailIdx !== null;
  const selectedEntry = inDetail ? filtered[detailIdx] : null;
  const detailLines = useMemo(
    () => (selectedEntry ? config.getDetailLines(selectedEntry) : []),
    [selectedEntry, config],
  );

  const showCopied = () => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  useKeyboard((evt) => {
    if (!visible) return;

    if (inDetail) {
      if (evt.name === "escape") {
        setDetailIdx(null);
        detailOffset.current = 0;
        return;
      }
      if (evt.name === "up" || evt.name === "k") {
        const n = Math.max(0, detailOffset.current - 1);
        detailOffset.current = n;
        detailScrollRef.current?.scrollTo(n);
        return;
      }
      if (evt.name === "down" || evt.name === "j") {
        const maxOff = Math.max(0, detailLines.length - detailRows);
        const n = Math.min(maxOff, detailOffset.current + 1);
        detailOffset.current = n;
        detailScrollRef.current?.scrollTo(n);
        return;
      }
      if (evt.ctrl && evt.name === "y" && selectedEntry) {
        copyToClipboard(config.getCopyText(selectedEntry));
        showCopied();
      }
      return;
    }

    if (evt.name === "escape") {
      onClose();
      return;
    }
    if (evt.name === "return") {
      if (filtered[cursorRef.current]) setDetailIdx(cursorRef.current);
      return;
    }
    if (evt.ctrl && evt.name === "y") {
      const e = filtered[cursorRef.current];
      if (e) {
        copyToClipboard(config.getCopyText(e));
        showCopied();
      }
      return;
    }

    if (handleCursorNavKey(evt, setCursor, filtered.length)) return;
    if (handleTextInputKey(evt, setQuery)) {
      listOffset.current = 0;
      listScrollRef.current?.scrollTo(0);
      setCursor(0);
    }
  });

  if (!visible) return null;

  if (inDetail && selectedEntry) {
    const dh = config.getDetailHeader(selectedEntry);
    return (
      <PremiumPopup
        visible={visible}
        width={popupW}
        height={popupH}
        title={dh.label}
        titleIcon={config.titleIcon}
        borderColor={config.borderColor}
        blurb={`${dh.sublabel ? `${dh.sublabel} · ` : ""}${dh.timeStr}${copied ? " · Copied!" : ""}`}
        footerHints={[
          { key: "↑↓", label: "scroll" },
          { key: "^Y", label: "copy" },
          { key: "Esc", label: "back" },
        ]}
      >
        <Section>
          <scrollbox ref={detailScrollRef} height={detailRows}>
            {detailLines.map((line, i) => {
              const isSection = line.startsWith("──");
              return (
                <box
                  // biome-ignore lint/suspicious/noArrayIndexKey: positional
                  key={`d-${i}`}
                  flexDirection="row"
                  height={1}
                  backgroundColor={t.bgPopup}
                >
                  <text
                    bg={t.bgPopup}
                    fg={
                      isSection
                        ? (config.detailSectionColor ?? config.borderColor)
                        : t.textSecondary
                    }
                    attributes={isSection ? BOLD : undefined}
                  >
                    {line.length > contentW ? `${line.slice(0, contentW - 1)}…` : line || " "}
                  </text>
                </box>
              );
            })}
          </scrollbox>
        </Section>
      </PremiumPopup>
    );
  }

  return (
    <PremiumPopup
      visible={visible}
      width={popupW}
      height={popupH}
      title={config.title}
      titleIcon={config.titleIcon}
      borderColor={config.borderColor}
      blurb={`${config.countLabel(filtered.length)}${copied ? " · Copied!" : ""}`}
      footerHints={[
        { key: "↑↓", label: "nav" },
        { key: "Enter", label: "detail" },
        { key: "^Y", label: "copy" },
        { key: "Esc", label: "close" },
      ]}
    >
      <Section>
        <Search
          value={query}
          focused={true}
          placeholder={config.filterPlaceholder}
          count={query ? `${filtered.length} / ${entries.length}` : undefined}
        />
        <VSpacer />
        {filtered.length === 0 ? (
          <box flexDirection="row" paddingX={2} paddingY={1} backgroundColor={t.bgPopup}>
            <text bg={t.bgPopup} fg={t.textMuted}>
              · {query ? config.emptyFilterMessage : config.emptyMessage}
            </text>
          </box>
        ) : (
          <box flexDirection="column" backgroundColor={t.bgPopup}>
            <scrollbox ref={listScrollRef} height={listRows}>
              {filtered.map((e, i) => {
                const isActive = i === cursor;
                const rowBg = isActive ? t.bgPopupHighlight : t.bgPopup;
                const row = config.renderListRow(e, contentW);
                return (
                  <box key={e.id} flexDirection="row" height={1} backgroundColor={rowBg}>
                    <text bg={rowBg} fg={isActive ? config.cursorColor : t.textFaint}>
                      {isActive ? "› " : "  "}
                    </text>
                    <text bg={rowBg} fg={row.iconColor}>
                      {row.icon}{" "}
                    </text>
                    <text
                      bg={rowBg}
                      fg={isActive ? t.textPrimary : t.textSecondary}
                      attributes={isActive ? BOLD : undefined}
                    >
                      {row.label}
                    </text>
                    <text bg={rowBg} fg={t.textMuted}>
                      {" "}
                      {row.summary}
                    </text>
                    {row.extra ? (
                      <text bg={rowBg} fg={row.extraColor ?? t.brand}>
                        {row.extra}
                      </text>
                    ) : null}
                    <box flexGrow={1} backgroundColor={rowBg} />
                    <text bg={rowBg} fg={t.textDim}>
                      {" "}
                      {row.timeStr}
                    </text>
                  </box>
                );
              })}
            </scrollbox>
            {filtered.length > listRows ? (
              <box flexDirection="row" paddingX={2} height={1} backgroundColor={t.bgPopup}>
                <text bg={t.bgPopup} fg={t.textFaint}>
                  {cursor + 1} / {filtered.length}
                </text>
              </box>
            ) : null}
          </box>
        )}
      </Section>
    </PremiumPopup>
  );
}
