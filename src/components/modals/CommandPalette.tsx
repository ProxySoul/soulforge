import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CATEGORIES, type CommandDef, getCommandDefs } from "../../core/commands/registry.js";
import { fuzzyMatch } from "../../core/history/fuzzy.js";
import { icon } from "../../core/icons.js";
import { usePopupScroll } from "../../hooks/usePopupScroll.js";
import { Overlay, POPUP_BG, POPUP_HL, PopupRow } from "../layout/shared.js";

const MAX_POPUP_WIDTH = 64;
const CHROME_ROWS = 6;

const CATEGORY_ICONS: Record<string, string> = {
  Git: "git",
  Session: "clock_alt",
  Models: "system",
  Settings: "cog",
  Editor: "pencil",
  Intelligence: "brain",
  Tabs: "tabs",
  System: "ghost",
};

const CATEGORY_COLORS: Record<string, string> = {
  Git: "#FF8C00",
  Session: "#00BFFF",
  Models: "#8B5CF6",
  Settings: "#9B30FF",
  Editor: "#2d5",
  Intelligence: "#FF0040",
  Tabs: "#FF8C00",
  System: "#666",
};

interface PaletteItem {
  type: "header" | "command";
  category?: string;
  def?: CommandDef;
  matchIndices?: number[];
  score?: number;
}

function buildGroupedItems(defs: CommandDef[]): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const cat of CATEGORIES) {
    const cmds = defs.filter((d) => d.category === cat);
    if (cmds.length === 0) continue;
    items.push({ type: "header", category: cat });
    for (const def of cmds) items.push({ type: "command", def, category: cat });
  }
  return items;
}

function buildFilteredItems(defs: CommandDef[], query: string): PaletteItem[] {
  const results: { def: CommandDef; score: number; indices: number[] }[] = [];
  for (const def of defs) {
    const target = `${def.cmd} ${def.desc} ${def.tags?.join(" ") ?? ""}`;
    const m = fuzzyMatch(query, target);
    if (m) results.push({ def, score: m.score, indices: m.indices });
  }
  results.sort((a, b) => b.score - a.score);
  return results.map((r) => ({
    type: "command" as const,
    def: r.def,
    matchIndices: r.indices,
    score: r.score,
    category: r.def.category,
  }));
}

function isSelectable(item: PaletteItem): boolean {
  return item.type === "command";
}

function findNextSelectable(items: PaletteItem[], from: number, dir: 1 | -1): number {
  const len = items.length;
  if (len === 0) return 0;
  let idx = from + dir;
  if (idx < 0) idx = len - 1;
  if (idx >= len) idx = 0;
  const start = idx;
  for (;;) {
    const item = items[idx];
    if (!item || isSelectable(item)) break;
    idx += dir;
    if (idx < 0) idx = len - 1;
    if (idx >= len) idx = 0;
    if (idx === start) break;
  }
  return idx;
}

function findNextCategory(items: PaletteItem[], from: number): number {
  for (let i = from + 1; i < items.length; i++) {
    if (items[i]?.type === "header") {
      const next = i + 1;
      if (next < items.length && items[next] && isSelectable(items[next])) return next;
    }
  }
  for (let i = 0; i < from; i++) {
    if (items[i]?.type === "header") {
      const next = i + 1;
      if (next < items.length && items[next] && isSelectable(items[next])) return next;
    }
  }
  return from;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  onExecute: (cmd: string) => void;
}

export function CommandPalette({ visible, onClose, onExecute }: Props) {
  const { width: termCols, height: termRows } = useTerminalDimensions();
  const containerRows = termRows - 2;
  const popupWidth = Math.min(MAX_POPUP_WIDTH, Math.floor(termCols * 0.85));
  const innerW = popupWidth - 2;
  const maxVisible = Math.max(6, Math.floor(containerRows * 0.75) - CHROME_ROWS);

  const [query, setQuery] = useState("");
  const { cursor, setCursor, scrollOffset, adjustScroll, resetScroll } = usePopupScroll(maxVisible);

  const allDefs = useMemo(() => getCommandDefs().filter((d) => !d.hidden), []);
  const items = useMemo(
    () => (query ? buildFilteredItems(allDefs, query) : buildGroupedItems(allDefs)),
    [allDefs, query],
  );

  const prevVisibleRef = useRef(false);
  useEffect(() => {
    const justOpened = visible && !prevVisibleRef.current;
    prevVisibleRef.current = visible;
    if (!visible) return;
    if (justOpened) setQuery("");
    const firstCmd = items.findIndex(isSelectable);
    setCursor(firstCmd >= 0 ? firstCmd : 0);
    resetScroll();
  }, [visible, items, setCursor, resetScroll]);

  const execute = useCallback(
    (item: PaletteItem) => {
      if (item.def) {
        onClose();
        onExecute(item.def.cmd);
      }
    },
    [onClose, onExecute],
  );

  useKeyboard((evt) => {
    if (!visible) return;

    if (evt.name === "escape") {
      if (query) {
        setQuery("");
        resetScroll();
      } else {
        onClose();
      }
      return;
    }

    if (evt.name === "return") {
      const item = items[cursor];
      if (item && isSelectable(item)) execute(item);
      return;
    }

    if (evt.name === "up" || (evt.name === "k" && evt.ctrl)) {
      const next = findNextSelectable(items, cursor, -1);
      setCursor(next);
      adjustScroll(next);
      return;
    }

    if (evt.name === "down" || (evt.name === "j" && evt.ctrl)) {
      const next = findNextSelectable(items, cursor, 1);
      setCursor(next);
      adjustScroll(next);
      return;
    }

    if (evt.name === "tab" && !query) {
      const next = findNextCategory(items, cursor);
      setCursor(next);
      adjustScroll(next);
      return;
    }

    if (evt.name === "backspace" || evt.name === "delete") {
      setQuery((q) => q.slice(0, -1));
      resetScroll();
      return;
    }

    if (evt.ctrl && evt.name === "u") {
      setQuery("");
      resetScroll();
      return;
    }

    if (evt.name === "space") {
      setQuery((q) => `${q} `);
      resetScroll();
      return;
    }

    if (evt.name && evt.name.length === 1 && !evt.ctrl && !evt.meta) {
      setQuery((q) => q + evt.name);
      resetScroll();
    }
  });

  if (!visible) return null;

  const visibleItems = items.slice(scrollOffset, scrollOffset + maxVisible);

  return (
    <Overlay>
      <box
        flexDirection="column"
        borderStyle="rounded"
        border={true}
        borderColor="#8B5CF6"
        width={popupWidth}
      >
        {/* Title */}
        <PopupRow w={innerW}>
          <text fg="#9B30FF" bg={POPUP_BG}>
            {icon("lightning")}{" "}
          </text>
          <text fg="white" attributes={TextAttributes.BOLD} bg={POPUP_BG}>
            Command Palette
          </text>
        </PopupRow>

        {/* Search input */}
        <PopupRow w={innerW}>
          <text fg="#8B5CF6" bg={POPUP_BG}>
            {icon("search")} {"> "}
          </text>
          <text fg="white" bg={POPUP_BG}>
            {query}
          </text>
          <text fg="#8B5CF6" bg={POPUP_BG}>
            {"▎"}
          </text>
          {!query && (
            <text fg="#444" bg={POPUP_BG}>
              {" type to search…"}
            </text>
          )}
        </PopupRow>

        {/* Separator */}
        <PopupRow w={innerW}>
          <text fg="#222" bg={POPUP_BG}>
            {"─".repeat(innerW - 4)}
          </text>
        </PopupRow>

        {/* Items */}
        <box
          flexDirection="column"
          height={Math.min(items.length || 1, maxVisible)}
          overflow="hidden"
        >
          {visibleItems.map((item, vi) => {
            const idx = vi + scrollOffset;

            if (item.type === "header") {
              const cat = item.category ?? "";
              const catColor = CATEGORY_COLORS[cat] ?? "#666";
              const catIcon = CATEGORY_ICONS[cat];
              return (
                <PopupRow key={`h-${cat}`} w={innerW}>
                  <text fg={catColor} bg={POPUP_BG} attributes={TextAttributes.BOLD}>
                    {catIcon ? `${icon(catIcon)} ` : ""}
                    {cat}
                  </text>
                </PopupRow>
              );
            }

            const def = item.def;
            if (!def) return null;
            const isActive = idx === cursor;
            const bg = isActive ? POPUP_HL : POPUP_BG;
            const catColor = CATEGORY_COLORS[item.category ?? ""] ?? "#8B5CF6";
            const cmdColor = isActive ? catColor : "#888";
            const descColor = isActive ? "#bbb" : "#555";
            const cmdText = def.cmd;

            return (
              <PopupRow key={def.cmd} bg={bg} w={innerW}>
                <text fg={isActive ? catColor : "#333"} bg={bg}>
                  {isActive ? "› " : "  "}
                </text>
                {renderHighlightedCmd(
                  cmdText,
                  item.matchIndices,
                  cmdColor,
                  isActive ? "#fff" : catColor,
                  bg,
                  isActive,
                )}
                <text fg={descColor} bg={bg} truncate>
                  {"  "}
                  {def.desc.length > innerW - cmdText.length - 8
                    ? `${def.desc.slice(0, innerW - cmdText.length - 11)}…`
                    : def.desc}
                </text>
              </PopupRow>
            );
          })}
        </box>

        {/* Scroll indicator */}
        {items.length > maxVisible && (
          <PopupRow w={innerW}>
            <text fg="#444" bg={POPUP_BG}>
              {scrollOffset > 0 ? "↑ " : "  "}
              {String(Math.max(1, items.slice(0, cursor + 1).filter(isSelectable).length))}/
              {String(items.filter(isSelectable).length)}
              {scrollOffset + maxVisible < items.length ? " ↓" : ""}
            </text>
          </PopupRow>
        )}

        {/* Footer */}
        <PopupRow w={innerW}>
          <text fg="#444" bg={POPUP_BG}>
            {"↑↓"} navigate
            {!query ? " │ ⇥ jump" : ""}
            {" │ ⏎ run │ esc "}
            {query ? "clear" : "close"}
          </text>
        </PopupRow>
      </box>
    </Overlay>
  );
}

function renderHighlightedCmd(
  cmd: string,
  indices: number[] | undefined,
  baseFg: string,
  hlFg: string,
  bg: string,
  bold: boolean,
): React.ReactNode {
  if (!indices || indices.length === 0) {
    return (
      <text fg={baseFg} bg={bg} attributes={bold ? TextAttributes.BOLD : undefined}>
        {cmd}
      </text>
    );
  }
  const highlightSet = new Set(indices.filter((i) => i < cmd.length));
  if (highlightSet.size === 0) {
    return (
      <text fg={baseFg} bg={bg} attributes={bold ? TextAttributes.BOLD : undefined}>
        {cmd}
      </text>
    );
  }

  const spans: React.ReactNode[] = [];
  let run = "";
  let runHl = false;

  const flush = () => {
    if (!run) return;
    spans.push(
      <span
        key={spans.length}
        fg={runHl ? hlFg : baseFg}
        bg={bg}
        attributes={runHl ? TextAttributes.BOLD : undefined}
      >
        {run}
      </span>,
    );
    run = "";
  };

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i] ?? "";
    const isHl = highlightSet.has(i);
    if (i === 0) {
      runHl = isHl;
      run = ch;
    } else if (isHl === runHl) {
      run += ch;
    } else {
      flush();
      runHl = isHl;
      run = ch;
    }
  }
  flush();

  return <text bg={bg}>{spans}</text>;
}
