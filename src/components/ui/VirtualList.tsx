import type { ScrollBoxRenderable } from "@opentui/core";
import { type ReactNode, useEffect, useRef } from "react";
import { useTheme } from "../../core/theme/index.js";

const DIM = 2;

export interface VirtualListProps<Item> {
  /** Item array. */
  items: Item[];
  /** Currently-selected index. Caller owns this state. -1 = none. */
  selectedIndex: number;
  /** Render function for each row. */
  renderItem: (
    item: Item,
    state: { index: number; selected: boolean; focused: boolean },
  ) => ReactNode;
  /** Stable key for each row. Falls back to index. */
  keyExtractor?: (item: Item, index: number) => string;
  /** Total outer width in cells. */
  width: number;
  /** Number of rows visible in the viewport. */
  maxRows: number;
  /** Focus state — dims empty-state + counter when unfocused. */
  focused?: boolean;
  /** Message when items is empty. */
  emptyMessage?: string;
  /** Row height (default 1). */
  rowHeight?: number;
  /** Render a trailing "N / total" counter when overflow. Default true. */
  showCounter?: boolean;
  bg?: string;
}

/**
 * VirtualList — scroll-aware renderer owning the `<scrollbox>` viewport.
 *
 * The primitive owns:
 *  - the scrollbox ref + internal offset
 *  - the scroll-into-view effect (selection escapes viewport → scroll)
 *  - empty-state + overflow counter
 *
 * The caller owns:
 *  - the `selectedIndex` state
 *  - all keyboard handling (up/down/enter/etc)
 *  - the row JSX via `renderItem`
 *
 * Use when `Table` (columnar) and `GroupedList` (tree) don't fit — e.g.
 * custom row shapes, cards, mixed toggles/chips, tool lists.
 */
export function VirtualList<Item>({
  items,
  selectedIndex,
  renderItem,
  keyExtractor,
  width,
  maxRows,
  focused = true,
  emptyMessage = "No results",
  rowHeight = 1,
  showCounter = true,
  bg,
}: VirtualListProps<Item>) {
  const t = useTheme();
  const fill = bg ?? t.bgPopup;
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const scrollOffset = useRef(0);

  const viewportRows = Math.min(maxRows, items.length);
  const viewportHeight = Math.max(1, viewportRows) * rowHeight;

  // Scroll-into-view: only shift viewport when selection escapes it.
  useEffect(() => {
    if (selectedIndex < 0 || items.length === 0) return;
    const offset = scrollOffset.current;
    if (selectedIndex < offset) {
      scrollOffset.current = selectedIndex;
      scrollRef.current?.scrollTo(selectedIndex);
    } else if (selectedIndex >= offset + viewportRows) {
      const newOffset = selectedIndex - viewportRows + 1;
      scrollOffset.current = newOffset;
      scrollRef.current?.scrollTo(newOffset);
    }
  }, [selectedIndex, items.length, viewportRows]);

  if (items.length === 0) {
    return (
      <box flexDirection="row" paddingX={2} paddingY={1} backgroundColor={fill} width={width}>
        <text bg={fill} fg={t.textFaint} attributes={DIM}>
          · {emptyMessage}
        </text>
      </box>
    );
  }

  return (
    <box flexDirection="column" backgroundColor={fill} width={width}>
      <scrollbox ref={scrollRef} height={viewportHeight}>
        {items.map((item, idx) => {
          const key = keyExtractor ? keyExtractor(item, idx) : `vl-${idx}`;
          const node = renderItem(item, {
            index: idx,
            selected: idx === selectedIndex,
            focused,
          });
          return (
            <box key={key} flexDirection="column" flexShrink={0}>
              {node}
            </box>
          );
        })}
      </scrollbox>

      {showCounter && items.length > viewportRows && selectedIndex >= 0 ? (
        <box flexDirection="row" paddingX={2} height={1} flexShrink={0} backgroundColor={fill}>
          <text bg={fill} fg={t.textFaint}>
            {selectedIndex + 1} / {items.length}
          </text>
        </box>
      ) : null}
    </box>
  );
}
