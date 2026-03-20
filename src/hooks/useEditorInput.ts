import { useEffect, useRef } from "react";
import { EDITOR_COL_OFFSET, getEditorRowOffset, getEditorWidthPx } from "../core/editor/layout.js";

/**
 * Raw stdin → neovim key translator + click-to-focus handler.
 *
 * Runs whenever the editor panel is visible. Two modes:
 *
 * 1. Editor focused: keyboard → neovim, clicks in editor → neovim mouse,
 *    clicks outside editor → switch focus to chat
 * 2. Chat focused: keyboard → ignored (Ink handles it), clicks in editor
 *    area → switch focus to editor
 *
 * Mouse SGR sequences are always parsed for focus routing and never
 * forwarded as raw keys to prevent garbled input.
 */

const CTRL_C = 0x03;
const CTRL_E = 0x05;
const CTRL_S = 0x13;
const ESC = "\x1b";
const MOD_ARROW_RE = new RegExp(`^${ESC}\\[1;(\\d+)([A-HPS])$`);
const MOD_TILDE_RE = new RegExp(`^${ESC}\\[(\\d+);(\\d+)~$`);
const CSI_U_RE = new RegExp(`^${ESC}\\[(\\d+)(?:;(\\d+))?u$`);

// SGR mouse: ESC [ < Btn ; Col ; Row [Mm]
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC required
const MOUSE_SGR_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/;

const CSI_U_KEYMAP: Record<number, string> = {
  9: "Tab",
  13: "CR",
  27: "Esc",
  127: "BS",
  32: "Space",
};

function translateRawToVim(data: Buffer): string | null {
  // Keys to pass back to Ink (app-level shortcuts)
  if (data.length === 1 && (data[0] === CTRL_E || data[0] === CTRL_C)) return null;
  // Ctrl+S → save (VSCode habit): escape to normal, then :w
  if (data.length === 1 && data[0] === CTRL_S) return "<Esc>:w<CR>";

  if (data.length === 1) {
    const b = data[0] as number;

    if (b >= 0x01 && b <= 0x1a) {
      if (b === 0x09) return "<Tab>";
      if (b === 0x0a) return "<NL>";
      if (b === 0x0d) return "<CR>";
      if (b === 0x1b) return "<Esc>";
      return `<C-${String.fromCharCode(b + 0x60)}>`;
    }

    if (b === 0x7f) return "<BS>";

    if (b >= 0x20 && b <= 0x7e) {
      const ch = String.fromCharCode(b);
      return ch === "<" ? "<LT>" : ch;
    }

    return String.fromCharCode(b);
  }

  if (data[0] === 0x1b) {
    const seq = data.toString("latin1");

    if (data[1] === 0x5b) {
      if (seq === "\x1b[A") return "<Up>";
      if (seq === "\x1b[B") return "<Down>";
      if (seq === "\x1b[C") return "<Right>";
      if (seq === "\x1b[D") return "<Left>";
      if (seq === "\x1b[H") return "<Home>";
      if (seq === "\x1b[F") return "<End>";
      if (seq === "\x1b[Z") return "<S-Tab>";

      if (seq === "\x1b[2~") return "<Insert>";
      if (seq === "\x1b[3~") return "<Del>";
      if (seq === "\x1b[5~") return "<PageUp>";
      if (seq === "\x1b[6~") return "<PageDown>";

      if (seq === "\x1b[15~") return "<F5>";
      if (seq === "\x1b[17~") return "<F6>";
      if (seq === "\x1b[18~") return "<F7>";
      if (seq === "\x1b[19~") return "<F8>";
      if (seq === "\x1b[20~") return "<F9>";
      if (seq === "\x1b[21~") return "<F10>";
      if (seq === "\x1b[23~") return "<F11>";
      if (seq === "\x1b[24~") return "<F12>";

      const modArrow = seq.match(MOD_ARROW_RE);
      if (modArrow) {
        const mod = Number(modArrow[1]);
        const letter = modArrow[2] as string;
        const keyMap: Record<string, string> = {
          A: "Up",
          B: "Down",
          C: "Right",
          D: "Left",
          H: "Home",
          F: "End",
          P: "F1",
          Q: "F2",
          R: "F3",
          S: "F4",
        };
        const vimKey = keyMap[letter];
        if (vimKey) return `<${modPrefix(mod)}${vimKey}>`;
      }

      const modTilde = seq.match(MOD_TILDE_RE);
      if (modTilde) {
        const num = modTilde[1];
        const mod = Number(modTilde[2]);
        const tildeMap: Record<string, string> = {
          "2": "Insert",
          "3": "Del",
          "5": "PageUp",
          "6": "PageDown",
          "15": "F5",
          "17": "F6",
          "18": "F7",
          "19": "F8",
          "20": "F9",
          "21": "F10",
          "23": "F11",
          "24": "F12",
        };
        const vimKey = tildeMap[num as string];
        if (vimKey) return `<${modPrefix(mod)}${vimKey}>`;
      }

      const csiU = seq.match(CSI_U_RE);
      if (csiU) {
        const keycode = Number(csiU[1]);
        const mod = csiU[2] ? Number(csiU[2]) : 1;
        if (mod === 5 && (keycode === 101 || keycode === 99)) return null;
        if (mod === 5 && keycode === 115) return "<Esc>:w<CR>";
        const mapped = CSI_U_KEYMAP[keycode];
        if (mapped) {
          const prefix = mod > 1 ? modPrefix(mod) : "";
          return `<${prefix}${mapped}>`;
        }
        if (keycode >= 32 && keycode < 127) {
          const ch = String.fromCharCode(keycode);
          if (mod > 1) return `<${modPrefix(mod)}${ch}>`;
          return ch === "<" ? "<LT>" : ch;
        }
      }
    }

    if (data[1] === 0x4f) {
      if (seq === "\x1bOP") return "<F1>";
      if (seq === "\x1bOQ") return "<F2>";
      if (seq === "\x1bOR") return "<F3>";
      if (seq === "\x1bOS") return "<F4>";
    }

    if (data.length === 2 && (data[1] as number) >= 0x20) {
      const ch = String.fromCharCode(data[1] as number);
      return `<A-${ch}>`;
    }

    if (data.length === 1) return "<Esc>";
  }

  return data.toString("utf-8");
}

function modPrefix(mod: number): string {
  const parts: string[] = [];
  const m = mod - 1;
  if (m & 4) parts.push("C");
  if (m & 2) parts.push("A");
  if (m & 1) parts.push("S");
  return parts.length > 0 ? `${parts.join("-")}-` : "";
}

// SGR button codes
const BTN_LEFT = 0;
const BTN_LEFT_DRAG = 32;
const BTN_SCROLL_UP = 64;
const BTN_SCROLL_DOWN = 65;

interface EditorInputOptions {
  sendKeys: (keys: string) => Promise<void>;
  sendMouse: (button: string, action: string, row: number, col: number) => Promise<void>;
  isEditorFocused: boolean;
  isEditorVisible: boolean;
  onFocusChat: () => void;
  onFocusEditor: () => void;
  hasTabBar?: boolean;
  editorSplit?: number;
}

/**
 * Unified stdin handler for editor panel.
 * Active whenever the editor is visible — handles both keyboard routing
 * and click-to-focus between editor and chat panels.
 */
export function useEditorInput({
  sendKeys,
  sendMouse,
  isEditorFocused,
  isEditorVisible,
  onFocusChat,
  onFocusEditor,
  hasTabBar = true,
  editorSplit = 60,
}: EditorInputOptions): void {
  const sendKeysRef = useRef(sendKeys);
  sendKeysRef.current = sendKeys;
  const sendMouseRef = useRef(sendMouse);
  sendMouseRef.current = sendMouse;
  const focusedRef = useRef(isEditorFocused);
  focusedRef.current = isEditorFocused;
  const onFocusChatRef = useRef(onFocusChat);
  onFocusChatRef.current = onFocusChat;
  const onFocusEditorRef = useRef(onFocusEditor);
  onFocusEditorRef.current = onFocusEditor;
  const hasTabBarRef = useRef(hasTabBar);
  hasTabBarRef.current = hasTabBar;
  const editorSplitRef = useRef(editorSplit);
  editorSplitRef.current = editorSplit;

  useEffect(() => {
    if (!isEditorVisible) return;

    const handler = (data: Buffer | string) => {
      const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
      const seq = buf.toString("latin1");

      const mouse = seq.match(MOUSE_SGR_RE);
      if (mouse) {
        const button = Number(mouse[1]);
        const termCol = Number(mouse[2]); // 1-based
        const termRow = Number(mouse[3]); // 1-based
        const isPress = mouse[4] === "M";

        const editorWidth = getEditorWidthPx(process.stdout.columns ?? 120, editorSplitRef.current);
        const inEditor = termCol <= editorWidth;

        if (button === BTN_LEFT && isPress) {
          if (inEditor && !focusedRef.current) onFocusEditorRef.current();
          if (!inEditor && focusedRef.current) onFocusChatRef.current();
        }

        if (focusedRef.current && inEditor) {
          const rowOffset = getEditorRowOffset(hasTabBarRef.current);
          const nvimRow = termRow - rowOffset - 1;
          const nvimCol = termCol - EDITOR_COL_OFFSET - 1;
          if (nvimRow >= 0 && nvimCol >= 0) {
            if (button === BTN_SCROLL_UP) {
              sendMouseRef.current("wheel", "up", nvimRow, nvimCol);
            } else if (button === BTN_SCROLL_DOWN) {
              sendMouseRef.current("wheel", "down", nvimRow, nvimCol);
            } else if (button === BTN_LEFT) {
              sendMouseRef.current("left", isPress ? "press" : "release", nvimRow, nvimCol);
            } else if (button === BTN_LEFT_DRAG) {
              sendMouseRef.current("left", "drag", nvimRow, nvimCol);
            }
          }
        }
        return;
      }

      // Ctrl+Shift+E (CSI u) → bypass to Ink for focus switching
      if (seq === "\x1b[101;6u" || seq === "\x1b[69;6u") return;

      if (!focusedRef.current) return;

      const vimKeys = translateRawToVim(buf);
      if (vimKeys !== null) {
        sendKeysRef.current(vimKeys).catch(() => {});
      }
    };

    process.stdin.on("data", handler);
    return () => {
      process.stdin.removeListener("data", handler);
    };
  }, [isEditorVisible]);
}
