import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useState } from "react";
import { usePopupScroll } from "../../hooks/usePopupScroll.js";
import { copyToClipboard } from "../../utils/clipboard.js";
import { Overlay, POPUP_BG, POPUP_HL, PopupRow } from "../layout/shared.js";

const CHROME_ROWS = 7;

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

export function LogViewer<T extends LogViewerEntry>({
  visible,
  onClose,
  entries,
  config,
}: Props<T>) {
  const [query, setQuery] = useState("");
  const [detailIndex, setDetailIndex] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [detailScrollOffset, setDetailScrollOffset] = useState(0);
  const { width: termCols, height: termRows } = useTerminalDimensions();
  const popupWidth = Math.max(60, Math.round(termCols * 0.85));
  const innerW = popupWidth - 2;
  const popupHeight = Math.max(12, Math.round(termRows * (config.heightRatio ?? 0.7)));
  const maxListVisible = Math.max(4, popupHeight - CHROME_ROWS);
  const maxDetailLines = Math.max(4, popupHeight - 6);
  const { cursor, setCursor, scrollOffset, adjustScroll, resetScroll } =
    usePopupScroll(maxListVisible);

  const filterQuery = query.toLowerCase().trim();
  const filtered = filterQuery ? entries.filter((e) => config.filterFn(e, filterQuery)) : entries;

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

  const detailLines = selectedEntry ? config.getDetailLines(selectedEntry) : [];

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
          copyToClipboard(config.getCopyText(selectedEntry));
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
      if (filtered[cursor]) setDetailIndex(cursor);
      return;
    }

    if (evt.name === "y" && evt.ctrl) {
      const entry = filtered[cursor];
      if (entry) {
        copyToClipboard(config.getCopyText(entry));
        showCopied();
      }
      return;
    }

    if (evt.name === "backspace" || evt.name === "delete") {
      setQuery((prev) => prev.slice(0, -1));
      resetScroll();
      return;
    }

    if (evt.name === "space") {
      setQuery((prev) => `${prev} `);
      resetScroll();
      return;
    }

    if (evt.name && evt.name.length === 1 && !evt.ctrl && !evt.meta) {
      setQuery((prev) => prev + evt.name);
      resetScroll();
    }
  });

  if (!visible) return null;

  const sectionColor = config.detailSectionColor ?? config.borderColor;

  if (inDetail && selectedEntry) {
    const dh = config.getDetailHeader(selectedEntry);
    return (
      <Overlay>
        <box
          flexDirection="column"
          borderStyle="rounded"
          border={true}
          borderColor={config.borderColor}
          width={popupWidth}
        >
          <PopupRow w={innerW}>
            <text fg={dh.iconColor} bg={POPUP_BG}>
              {dh.icon}
            </text>
            <text fg="white" attributes={TextAttributes.BOLD} bg={POPUP_BG}>
              {" "}
              {dh.label}
            </text>
            {dh.sublabel && (
              <text fg={dh.sublabelColor ?? "#9B30FF"} bg={POPUP_BG}>
                {"  "}
                {dh.sublabel}
              </text>
            )}
            <text fg="#555" bg={POPUP_BG}>
              {"  "}
              {dh.timeStr}
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
                      fg={isSection ? sectionColor : "#aaa"}
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
        borderColor={config.borderColor}
        width={popupWidth}
      >
        <PopupRow w={innerW}>
          <text fg={config.titleColor} attributes={TextAttributes.BOLD} bg={POPUP_BG}>
            {config.titleIcon} {config.title}
          </text>
          <text fg="#555" bg={POPUP_BG}>
            {" "}
            ({config.countLabel(entries.length)})
          </text>
          {copied && (
            <text fg="#2d5" bg={POPUP_BG}>
              {"  "}Copied!
            </text>
          )}
        </PopupRow>

        <PopupRow w={innerW}>
          <text fg={config.accentColor} bg={POPUP_BG}>
            {" "}
          </text>
          {query ? (
            <>
              <text fg="white" bg={POPUP_BG}>
                {query}
              </text>
              <text fg={config.accentColor} bg={POPUP_BG}>
                █
              </text>
            </>
          ) : (
            <>
              <text fg={config.accentColor} bg={POPUP_BG}>
                █
              </text>
              <text fg="#555" bg={POPUP_BG}>
                {config.filterPlaceholder}
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
                {query ? config.emptyFilterMessage : config.emptyMessage}
              </text>
            </PopupRow>
          ) : (
            filtered.slice(scrollOffset, scrollOffset + maxListVisible).map((entry, vi) => {
              const i = vi + scrollOffset;
              const isActive = i === cursor;
              const bg = isActive ? POPUP_HL : POPUP_BG;
              const row = config.renderListRow(entry, innerW);
              return (
                <PopupRow key={entry.id} bg={bg} w={innerW}>
                  <text bg={bg} fg={isActive ? config.cursorColor : "#555"}>
                    {isActive ? "› " : "  "}
                  </text>
                  <text bg={bg} fg={row.iconColor}>
                    {row.icon}{" "}
                  </text>
                  <text
                    bg={bg}
                    fg={isActive ? "white" : "#aaa"}
                    attributes={isActive ? TextAttributes.BOLD : undefined}
                  >
                    {row.label}
                  </text>
                  <text bg={bg} fg="#666">
                    {" "}
                    {row.summary}
                  </text>
                  {row.extra && (
                    <text bg={bg} fg={row.extraColor ?? "#9B30FF"}>
                      {row.extra}
                    </text>
                  )}
                  <text bg={bg} fg="#444">
                    {"  "}
                    {row.timeStr}
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
            ↑↓ nav | ⏎ detail | ^Y copy | esc close
          </text>
        </PopupRow>
      </box>
    </Overlay>
  );
}
