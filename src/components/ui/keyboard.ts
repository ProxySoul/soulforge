/**
 * Shared keyboard helpers for popup components.
 *
 * These functions are *not* hooks — they take the current state handlers
 * and return `true` when they handled the event, so callers can compose
 * them with their own custom keybindings.
 */

export interface KeyEvt {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

/**
 * Handle text-entry keys for a search/query field. Returns true if handled.
 *
 * Handles: printable char → append, Backspace → pop, Ctrl+U → clear.
 * Does NOT handle Escape, Enter, or arrow keys — caller owns those.
 */
export function handleTextInputKey(
  evt: KeyEvt,
  setValue: (updater: (prev: string) => string) => void,
): boolean {
  if (evt.name === "backspace" || evt.name === "delete") {
    setValue((p) => p.slice(0, -1));
    return true;
  }
  if (evt.ctrl && evt.name === "u") {
    setValue(() => "");
    return true;
  }
  const ch = evt.sequence;
  if (
    typeof ch === "string" &&
    ch.length === 1 &&
    ch >= " " &&
    ch !== "\x7f" &&
    !evt.ctrl &&
    !evt.meta
  ) {
    setValue((p) => p + ch);
    return true;
  }
  return false;
}

/**
 * Handle up/down (+ j/k) navigation with wrap-around. Returns true if handled.
 */
export function handleCursorNavKey(
  evt: KeyEvt,
  setCursor: (updater: (prev: number) => number) => void,
  max: number,
  allowVim = true,
): boolean {
  if (max <= 0) return false;
  if (evt.name === "up" || (allowVim && evt.name === "k" && !evt.ctrl)) {
    setCursor((c) => (c > 0 ? c - 1 : max - 1));
    return true;
  }
  if (evt.name === "down" || (allowVim && evt.name === "j" && !evt.ctrl)) {
    setCursor((c) => (c < max - 1 ? c + 1 : 0));
    return true;
  }
  return false;
}
