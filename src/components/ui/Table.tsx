import type { ScrollBoxRenderable } from "@opentui/core";
import { memo, type ReactNode, useEffect, useRef } from "react";
import { useTheme } from "../../core/theme/index.js";

const BOLD = 1;
const DIM = 2;

export type TableAlign = "left" | "right";

export interface TableColumn<Row> {
  /** Column header text (uppercased for muted header row). */
  key: string;
  /** Explicit width; omit to let remaining columns share leftover space. */
  width?: number;
  /** Alignment inside the cell. Default: left. */
  align?: TableAlign;
  /** Render function — default uses row[key] as string. */
  render?: (row: Row) => ReactNode;
}

export interface TableProps<Row> {
  columns: TableColumn<Row>[];
  rows: Row[];
  /** Total outer width in cells. Columns without explicit width share leftover. */
  width: number;
  /** Index of the highlighted row; -1 for none. */
  selectedIndex?: number;
  /** Focus state — dims header/borders when unfocused for calmer appearance. */
  focused?: boolean;
  /** Message when rows is empty. */
  emptyMessage?: string;
  /** Number of rows visible in the scroll viewport (default: all). */
  maxRows?: number;
  bg?: string;
  /** Max cell height before truncation (default 1). */
  rowHeight?: number;
}

function computeWidths<Row>(
  cols: TableColumn<Row>[],
  totalW: number,
  reserveScrollbar: boolean,
): number[] {
  const explicit = cols.reduce((a, c) => a + (c.width ?? 0), 0);
  const autoCount = cols.filter((c) => c.width == null).length;
  // Leading 2-space indicator + per-column 2-space trailing gutter + optional 1-col scrollbar.
  const paddingTotal = cols.length * 2 + 2 + (reserveScrollbar ? 1 : 0);
  const leftover = Math.max(0, totalW - explicit - paddingTotal);
  const autoW = autoCount > 0 ? Math.max(4, Math.floor(leftover / autoCount)) : 0;
  return cols.map((c) => c.width ?? autoW);
}

function pad(text: string, width: number, align: TableAlign): string {
  if (text.length === width) return text;
  if (text.length > width) return `${text.slice(0, Math.max(0, width - 1))}…`;
  const extra = width - text.length;
  return align === "right" ? " ".repeat(extra) + text : text + " ".repeat(extra);
}

/**
 * Table — keyboard-navigable, scrollable via OpenTUI's native <scrollbox>.
 *
 * Caller owns selectedIndex + key handling. When selectedIndex changes,
 * the viewport auto-scrolls to keep the row visible.
 *
 *  FIRST        LAST          EMAIL                     ROLE
 *  ─────────    ──────────    ──────────────────────    ────────
 *  ▸ Ada        Lovelace      ada@analytical.engine     admin
 *    Alan       Turing        alan@bletchley.uk         member
 */
function TableImpl<Row>({
  columns,
  rows,
  width,
  selectedIndex = -1,
  focused = true,
  emptyMessage = "No results",
  maxRows,
  bg,
  rowHeight = 1,
}: TableProps<Row>) {
  const t = useTheme();
  const fill = bg ?? t.bgPopup;
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const scrollOffset = useRef(0);
  const viewportRows = Math.min(maxRows ?? rows.length, rows.length);
  const viewportHeight = Math.max(1, viewportRows) * rowHeight;
  const overflow = rows.length > viewportRows;
  const widths = computeWidths(columns, width, overflow);

  // Scroll-into-view: only shift viewport when selection escapes it.
  useEffect(() => {
    if (selectedIndex < 0 || rows.length === 0) return;
    const offset = scrollOffset.current;
    if (selectedIndex < offset) {
      scrollOffset.current = selectedIndex;
      scrollRef.current?.scrollTo(selectedIndex);
    } else if (selectedIndex >= offset + viewportRows) {
      const newOffset = selectedIndex - viewportRows + 1;
      scrollOffset.current = newOffset;
      scrollRef.current?.scrollTo(newOffset);
    }
  }, [selectedIndex, rows.length, viewportRows]);

  const headerBg = focused ? t.bgPopup : fill;
  const headerFg = focused ? t.textMuted : t.textFaint;

  return (
    <box flexDirection="column" backgroundColor={fill} width={width}>
      {/* Header row */}
      <box flexDirection="row" backgroundColor={headerBg} height={1} flexShrink={0}>
        <text bg={headerBg}>{"  "}</text>
        {columns.map((c, i) => (
          <text key={c.key} bg={headerBg} fg={headerFg} attributes={BOLD}>
            {pad(c.key.toUpperCase(), widths[i] ?? 0, c.align ?? "left")}
            {"  "}
          </text>
        ))}
      </box>

      {/* Header rule */}
      <box flexDirection="row" backgroundColor={headerBg} height={1} flexShrink={0}>
        <text bg={headerBg}>{"  "}</text>
        {columns.map((c, i) => (
          <text key={c.key} bg={headerBg} fg={t.textFaint}>
            {"─".repeat(widths[i] ?? 0)}
            {"  "}
          </text>
        ))}
      </box>

      {/* Rows — scrollable viewport */}
      {rows.length === 0 ? (
        <box flexDirection="row" paddingX={2} paddingY={1} backgroundColor={fill}>
          <text bg={fill} fg={t.textFaint} attributes={DIM}>
            · {emptyMessage}
          </text>
        </box>
      ) : (
        <scrollbox ref={scrollRef} height={viewportHeight}>
          {rows.map((row, rIdx) => {
            const isSelected = rIdx === selectedIndex;
            const rowBg = isSelected ? t.bgPopupHighlight : fill;
            const rowFg = isSelected ? t.textPrimary : focused ? t.textSecondary : t.textMuted;
            return (
              <box
                // biome-ignore lint/suspicious/noArrayIndexKey: generic Table has no per-row id
                key={`row-${rIdx}`}
                flexDirection="row"
                backgroundColor={rowBg}
                height={rowHeight}
              >
                <text bg={rowBg} fg={isSelected ? t.brandSecondary : t.textFaint} attributes={BOLD}>
                  {isSelected ? "▸ " : "  "}
                </text>
                {columns.map((c, i) => {
                  const cellW = widths[i] ?? 0;
                  const align = c.align ?? "left";
                  const rendered = c.render
                    ? String(c.render(row) ?? "")
                    : String((row as Record<string, unknown>)[c.key] ?? "");
                  return (
                    <text
                      key={c.key}
                      bg={rowBg}
                      fg={rowFg}
                      attributes={isSelected ? BOLD : undefined}
                    >
                      {pad(rendered, cellW, align)}
                      {"  "}
                    </text>
                  );
                })}
              </box>
            );
          })}
        </scrollbox>
      )}

      {/* Scroll indicator — shown when more rows exist than fit */}
      {rows.length > viewportRows && selectedIndex >= 0 ? (
        <box flexDirection="row" paddingX={2} height={1} flexShrink={0} backgroundColor={fill}>
          <text bg={fill} fg={t.textFaint}>
            {selectedIndex + 1} / {rows.length}
          </text>
        </box>
      ) : null}
    </box>
  );
}

export const Table = memo(TableImpl) as typeof TableImpl;
