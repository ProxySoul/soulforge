import type { ScrollBoxRenderable } from "@opentui/core";
import { memo, useEffect, useMemo, useRef } from "react";
import { icon as iconFn } from "../../core/icons.js";
import { useTheme } from "../../core/theme/index.js";
import { Spinner } from "../layout/shared.js";

const BOLD = 1;
const DIM = 2;

// ── Types ──────────────────────────────────────────────────────────────────

export interface GroupedItem {
  /** Unique within its group. */
  id: string;
  /** Primary text (bold when selected). */
  label: string;
  /** Right-side metadata (tokens, version, etc.). Rendered in muted. */
  meta?: string;
  /** Optional status dot: online / warning / error / offline. */
  status?: "online" | "offline" | "warning" | "error" | "idle";
  /** Disable (greyed out, still navigable if you choose). */
  disabled?: boolean;
  /** Marks this item as the currently-active value (checkmark + brand color). */
  active?: boolean;
  /** Char indices in `label` to highlight (e.g. fuzzy-match positions). */
  highlightIndices?: number[];
  /** Prefix rendered before the label in muted text (e.g. category badge). */
  prefix?: string;
  /** Mnemonic key rendered as a `[key]` cap before the label. */
  keyHint?: string;
}

export interface GroupedListGroup<Item extends GroupedItem = GroupedItem> {
  id: string;
  label: string;
  /** Nerd-font icon name (resolved via core/icons.ts). */
  icon?: string;
  /** Pre-rendered glyph — takes precedence over `icon`. Use for provider icons. */
  iconGlyph?: string;
  /** Optional counter (default: items.length). Ignored when `meta` is set. */
  count?: number;
  items: Item[];
  /** Render a spinner on the right side of the group header. */
  loading?: boolean;
  /** Right-side meta text (overrides the count). Use for "no key", errors, etc. */
  meta?: string;
  /** Right-side status dot before the count/meta. */
  status?: "online" | "offline" | "warning" | "error" | "idle";
  /** Hide this group's header row entirely. Useful for flat search-result lists. */
  hideHeader?: boolean;
  /** Override the accent color for this group's header (label + caret). */
  accent?: string;
}

/** Flat row descriptor — mix of group headers and item rows. */
export interface GroupedRow<Item extends GroupedItem = GroupedItem> {
  kind: "group" | "item";
  groupId: string;
  groupIndex: number;
  /** Defined only for kind="item". */
  itemIndex?: number;
  /** Defined only for kind="item". */
  item?: Item;
  /** Defined only for kind="group". */
  group?: GroupedListGroup<Item>;
  expanded?: boolean;
}

export interface GroupedListProps<Item extends GroupedItem = GroupedItem> {
  groups: GroupedListGroup<Item>[];
  /** Set of group ids currently expanded. */
  expanded: Set<string>;
  /** Index into the flattened visible-row list (result of `buildRows`). */
  selectedIndex: number;
  /** Outer width (border not drawn by this primitive). */
  width: number;
  /** Rows visible in the scroll viewport. */
  maxRows?: number;
  focused?: boolean;
  emptyMessage?: string;
  bg?: string;
}

// ── Helper: compute flat row list ─────────────────────────────────────────

export function buildGroupedRows<Item extends GroupedItem>(
  groups: GroupedListGroup<Item>[],
  expanded: Set<string>,
): GroupedRow<Item>[] {
  const rows: GroupedRow<Item>[] = [];
  groups.forEach((g, gi) => {
    const isExpanded = g.hideHeader || expanded.has(g.id);
    if (!g.hideHeader) {
      rows.push({
        kind: "group",
        groupId: g.id,
        groupIndex: gi,
        group: g,
        expanded: isExpanded,
      });
    }
    if (isExpanded) {
      g.items.forEach((it, ii) => {
        rows.push({
          kind: "item",
          groupId: g.id,
          groupIndex: gi,
          itemIndex: ii,
          item: it,
        });
      });
    }
  });
  return rows;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function filteredGroupOf<Item extends GroupedItem>(
  groups: GroupedListGroup<Item>[],
  groupId: string,
): GroupedListGroup<Item> | undefined {
  return groups.find((g) => g.id === groupId);
}

// ── Label rendering ───────────────────────────────────────────────────────

/**
 * Split a label into <span> runs, highlighting chars at `indices`. Returns
 * null if there are no indices or they're out of range — caller should
 * render the label as a plain string instead.
 */
function renderLabelSpans(
  label: string,
  indices: number[] | undefined,
  baseFg: string,
  hlFg: string,
  bold: boolean,
): React.ReactNode[] | null {
  if (!indices || indices.length === 0) return null;
  const hlSet = new Set(indices.filter((i) => i >= 0 && i < label.length));
  if (hlSet.size === 0) return null;
  const spans: React.ReactNode[] = [];
  let run = "";
  let runHl = false;
  const flush = () => {
    if (!run) return;
    spans.push(
      <span
        key={spans.length}
        fg={runHl ? hlFg : baseFg}
        attributes={bold || runHl ? BOLD : undefined}
      >
        {run}
      </span>,
    );
    run = "";
  };
  for (let i = 0; i < label.length; i++) {
    const ch = label[i] ?? "";
    const isHl = hlSet.has(i);
    if (i === 0) {
      run = ch;
      runHl = isHl;
    } else if (isHl === runHl) {
      run += ch;
    } else {
      flush();
      run = ch;
      runHl = isHl;
    }
  }
  flush();
  return spans;
}

// ── Status dot colors ─────────────────────────────────────────────────────

function statusColor(
  t: ReturnType<typeof useTheme>,
  s: NonNullable<GroupedItem["status"]>,
): string {
  return s === "online"
    ? t.success
    : s === "warning"
      ? t.warning
      : s === "error"
        ? t.error
        : s === "offline"
          ? t.textDim
          : t.textFaint;
}

// ── GroupedList ───────────────────────────────────────────────────────────
//
//  ▾   Anthropic                                              3
//      ▸ claude-opus-4-7                          200K · new
//        claude-sonnet-4-6                       200K
//        claude-haiku-4-5                        200K · fast
//  ▸   OpenAI                                                 4
//  ▸   Google                                                 2
//  ▾   Vercel Gateway                                        12

function GroupedListImpl<Item extends GroupedItem>({
  groups,
  expanded,
  selectedIndex,
  width,
  maxRows,
  focused = true,
  emptyMessage = "No results",
  bg,
}: GroupedListProps<Item>) {
  const t = useTheme();
  const fill = bg ?? t.bgPopup;
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const scrollOffset = useRef(0);

  const rows = useMemo(() => buildGroupedRows(groups, expanded), [groups, expanded]);
  const viewportRows = Math.min(maxRows ?? rows.length, rows.length);
  const viewportHeight = Math.max(1, viewportRows);

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

  if (rows.length === 0) {
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
        {rows.map((r, idx) => {
          const isSelected = idx === selectedIndex;
          if (r.kind === "group") {
            const g = r.group;
            if (!g) return null;
            const rowBg = isSelected ? t.bgPopupHighlight : fill;
            const accent = g.accent ?? t.brand;
            const fg = isSelected ? accent : t.textPrimary;
            const caret = r.expanded ? "▾" : "▸";
            const count = g.count ?? g.items.length;
            const gStatusFg = g.status ? statusColor(t, g.status) : null;
            return (
              <box
                // biome-ignore lint/suspicious/noArrayIndexKey: keyed by flattened row idx
                key={`g-${idx}-${g.id}`}
                flexDirection="row"
                height={1}
                backgroundColor={rowBg}
              >
                <text bg={rowBg} fg={isSelected ? t.brandSecondary : t.textFaint}>
                  {" "}
                  {caret}{" "}
                </text>
                {g.iconGlyph || g.icon ? (
                  <text bg={rowBg} fg={fg}>
                    {g.iconGlyph ?? (g.icon ? iconFn(g.icon) : "")}
                    {"  "}
                  </text>
                ) : (
                  <text bg={rowBg}>{"  "}</text>
                )}
                <text bg={rowBg} fg={fg} attributes={BOLD}>
                  {g.label}
                </text>
                <box flexGrow={1} backgroundColor={rowBg} />
                {g.loading ? (
                  <box flexDirection="row" backgroundColor={rowBg}>
                    <Spinner color={t.brandSecondary} divisor={2} />
                    <text bg={rowBg} fg={t.textFaint}>
                      {"  "}
                    </text>
                  </box>
                ) : (
                  <>
                    {gStatusFg ? (
                      <text bg={rowBg}>
                        <span fg={gStatusFg}>●</span>
                        <span fg={t.textFaint}>{"  "}</span>
                      </text>
                    ) : null}
                    <text bg={rowBg} fg={g.meta ? t.textFaint : t.textMuted}>
                      {g.meta ?? String(count)}
                      {"  "}
                    </text>
                  </>
                )}
              </box>
            );
          }

          // item row
          const it = r.item;
          if (!it) return null;
          const parent = filteredGroupOf(groups, r.groupId);
          const accent = parent?.accent ?? t.brand;
          const rowBg = isSelected ? t.bgPopupHighlight : fill;
          const fg = it.disabled
            ? t.textDim
            : isSelected
              ? t.textPrimary
              : it.active
                ? accent
                : focused
                  ? t.textSecondary
                  : t.textMuted;
          const hlFg = isSelected ? t.textPrimary : accent;
          const labelBold = isSelected || !!it.active;
          const spans = renderLabelSpans(it.label, it.highlightIndices, fg, hlFg, labelBold);
          return (
            <box
              // biome-ignore lint/suspicious/noArrayIndexKey: keyed by flattened row idx
              key={`i-${idx}-${r.groupId}-${it.id}`}
              flexDirection="row"
              height={1}
              backgroundColor={rowBg}
            >
              <text bg={rowBg}>{"     "}</text>
              <text bg={rowBg} fg={isSelected ? t.brandSecondary : t.textFaint} attributes={BOLD}>
                {isSelected ? "▸" : " "}
              </text>
              {it.keyHint ? (
                <text bg={rowBg}>
                  {" "}
                  <span fg={t.textFaint}>[</span>
                  <span fg={isSelected ? t.brandSecondary : accent} attributes={BOLD}>
                    {it.keyHint}
                  </span>
                  <span fg={t.textFaint}>]</span>
                </text>
              ) : null}
              {it.prefix ? (
                <text bg={rowBg} fg={t.textFaint}>
                  {" "}
                  {it.prefix}
                </text>
              ) : null}
              <text bg={rowBg} fg={fg} attributes={labelBold ? BOLD : undefined}>
                {" "}
                {it.active ? "✓ " : ""}
                {spans ?? it.label}
              </text>
              {it.status ? (
                <text bg={rowBg}>
                  {"  "}
                  <span fg={statusColor(t, it.status)}>●</span>
                </text>
              ) : null}
              <box flexGrow={1} backgroundColor={rowBg} />
              {it.meta ? (
                <text bg={rowBg} fg={t.textFaint}>
                  {it.meta}
                  {"  "}
                </text>
              ) : null}
            </box>
          );
        })}
      </scrollbox>

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

export const GroupedList = memo(GroupedListImpl) as typeof GroupedListImpl;
