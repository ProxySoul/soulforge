// Shared layout constants for the editor panel.
// Used by: useNeovim (dimensions), useEditorInput (mouse offsets), EditorPanel (rendering)

// Border takes 1 char on each side = 2 total for width calculation
const EDITOR_BORDER_WIDTH = 2; // left border(1) + right border(1)

// Mouse click offset: only the left side matters (terminal col 1-based → nvim col 0-based)
export const EDITOR_COL_OFFSET = 1; // left border(1)

// Fixed rows consumed by app chrome around the editor content area:
// App: header(1) + footer(1)
// Editor panel: border-top(1) + border-bottom(1)
// Total = 4
const BASE_FIXED_ROWS = 4;
// TabBar when visible: marginTop(1) + bar(1) = 2 rows
const TAB_BAR_ROWS = 2;

export function getEditorDimensions(
  termCols: number,
  termRows: number,
  hasTabBar: boolean,
  splitPct = 60,
): { cols: number; rows: number } {
  const fixedRows = BASE_FIXED_ROWS + (hasTabBar ? TAB_BAR_ROWS : 0);
  const ratio = splitPct / 100;
  return {
    cols: Math.max(20, Math.floor(termCols * ratio) - EDITOR_BORDER_WIDTH),
    rows: Math.max(6, termRows - fixedRows),
  };
}

// Mouse row offset: how many terminal rows sit above the editor content area
// Header(1) + [TabBar margin(1) + TabBar(1)] + border(1) + title(1) + separator(1)
export function getEditorRowOffset(hasTabBar: boolean): number {
  return hasTabBar ? 6 : 4;
}

export function getEditorWidthPx(termCols: number, splitPct = 60): number {
  return Math.floor(termCols * (splitPct / 100));
}
