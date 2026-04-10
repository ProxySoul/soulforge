import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { CATEGORIES, type CommandDef, getCommandDefs } from "../../core/commands/registry.js";
import { fuzzyMatch } from "../../core/history/fuzzy.js";
import { icon } from "../../core/icons.js";
import { useTheme } from "../../core/theme/index.js";
import { useMarqueeScroll } from "../../hooks/useMarqueeScroll.js";
import { usePopupScroll } from "../../hooks/usePopupScroll.js";
import { POPUP_BG, POPUP_HL, Popup, PopupRow, PopupSeparator } from "../layout/shared.js";

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

function HeaderRow({
  category,
  catColor,
  catIcon,
  innerW,
}: {
  category: string;
  catColor: string;
  catIcon: string | undefined;
  innerW: number;
}) {
  return (
    <PopupRow w={innerW}>
      <text fg={catColor} bg={POPUP_BG} attributes={TextAttributes.BOLD}>
        {catIcon ? `${icon(catIcon)} ` : ""}
        {category}
      </text>
    </PopupRow>
  );
}

function CommandRow({
  def,
  isActive,
  catColor,
  innerW,
  matchIndices,
  textSecondary,
  textMuted,
  textFaint,
  textPrimary,
}: {
  def: CommandDef;
  isActive: boolean;
  catColor: string;
  innerW: number;
  matchIndices: number[] | undefined;
  textSecondary: string;
  textMuted: string;
  textFaint: string;
  textPrimary: string;
}) {
  const bg = isActive ? POPUP_HL : POPUP_BG;
  const cmdColor = isActive ? catColor : textSecondary;
  const descColor = isActive ? textSecondary : textMuted;
  const cmdText = def.cmd;

  const descMaxWidth = Math.max(0, innerW - cmdText.length - 12);
  const displayDesc = useMarqueeScroll(def.desc, descMaxWidth, isActive);

  return (
    <PopupRow bg={bg} w={innerW}>
      <text fg={isActive ? catColor : textFaint} bg={bg}>
        {isActive ? "› " : "  "}
      </text>
      <text fg={textMuted} bg={bg}>
        {def.category ? `${def.category.slice(0, 3).toLowerCase()} ` : ""}
      </text>
      {renderHighlightedCmd(
        cmdText,
        matchIndices,
        cmdColor,
        isActive ? textPrimary : catColor,
        bg,
        isActive,
      )}
      <text fg={descColor} bg={bg} truncate>
        {"  "}
        {displayDesc}
      </text>
    </PopupRow>
  );
}

interface Props {
  visible: boolean;
  onClose: () => void;
  onExecute: (cmd: string) => void;
}

export function CommandPalette({ visible, onClose, onExecute }: Props) {
  const t = useTheme();
  const { width: termCols, height: termRows } = useTerminalDimensions();
  const containerRows = termRows - 2;
  const popupWidth = Math.min(MAX_POPUP_WIDTH, Math.floor(termCols * 0.85));
  const innerW = popupWidth - 2;
  const maxVisible = Math.max(6, Math.floor(containerRows * 0.75) - CHROME_ROWS);

  const categoryColors: Record<string, string> = {
    Git: t.warning,
    Session: t.info,
    Models: t.brandAlt,
    Settings: t.brand,
    Editor: t.success,
    Intelligence: t.brandSecondary,
    Tabs: t.warning,
    System: t.textMuted,
  };

  const [query, setQuery] = useState("");
  const { cursor, setCursor, scrollOffset, adjustScroll, resetScroll } = usePopupScroll(maxVisible);

  const allDefs = getCommandDefs().filter((d) => !d.hidden);
  const items = query ? buildFilteredItems(allDefs, query) : buildGroupedItems(allDefs);

  const commandCount = items.filter(isSelectable).length;

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

  const execute = (item: PaletteItem) => {
    if (item.def) {
      onClose();
      onExecute(item.def.cmd);
    }
  };

  const handleKeyboard = (evt: { name?: string; ctrl?: boolean; meta?: boolean }) => {
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
  };

  useKeyboard(handleKeyboard);

  if (!visible) return null;

  const visibleItems = items.slice(scrollOffset, scrollOffset + maxVisible);
  const searchBg = t.bgPopupHighlight;

  return (
    <Popup
      width={popupWidth}
      title="Command Palette"
      icon={icon("lightning")}
      footer={[
        { key: "\u2191\u2193", label: "navigate" },
        ...(!query ? [{ key: "tab", label: "jump" }] : []),
        { key: "\u23CE", label: "run" },
        { key: "esc", label: query ? "clear" : "close" },
      ]}
    >
      {/* Search input */}
      <PopupRow w={innerW} bg={searchBg}>
        <text fg={t.brandAlt} bg={searchBg}>
          {"\uD83D\uDD0D"}{" "}
        </text>
        <text fg={t.textPrimary} bg={searchBg}>
          {query}
        </text>
        <text fg={t.brandAlt} bg={searchBg}>
          {"▎"}
        </text>
        {!query && (
          <text fg={t.textDim} bg={searchBg}>
            {" type to search…"}
          </text>
        )}
        {query && (
          <text fg={t.textDim} bg={searchBg}>
            {"  "}
            {String(commandCount)} result{commandCount !== 1 ? "s" : ""}
          </text>
        )}
      </PopupRow>

      {/* Separator */}
      <PopupSeparator w={innerW} />

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
            return (
              <HeaderRow
                key={`h-${cat}`}
                category={cat}
                catColor={categoryColors[cat] ?? t.textMuted}
                catIcon={CATEGORY_ICONS[cat]}
                innerW={innerW}
              />
            );
          }

          const def = item.def;
          if (!def) return null;

          return (
            <CommandRow
              key={def.cmd}
              def={def}
              isActive={idx === cursor}
              catColor={categoryColors[item.category ?? ""] ?? t.brandAlt}
              innerW={innerW}
              matchIndices={item.matchIndices}
              textSecondary={t.textSecondary}
              textMuted={t.textMuted}
              textFaint={t.textFaint}
              textPrimary={t.textPrimary}
            />
          );
        })}
      </box>

      {/* Scroll indicator */}
      {items.length > maxVisible && (
        <PopupRow w={innerW}>
          <text fg={t.textDim} bg={POPUP_BG}>
            {scrollOffset > 0 ? "↑ " : "  "}
            {String(Math.max(1, items.slice(0, cursor + 1).filter(isSelectable).length))}/
            {String(commandCount)}
            {scrollOffset + maxVisible < items.length ? " ↓" : ""}
          </text>
        </PopupRow>
      )}
    </Popup>
  );
}
