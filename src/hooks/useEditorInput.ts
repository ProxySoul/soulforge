import { useEffect, useRef } from "react";
import { getEditorWidthPx } from "../core/editor/layout.js";

/**
 * Raw stdin → PTY forwarder + click-to-focus handler.
 *
 * Runs whenever the editor panel is visible. Two modes:
 *
 * 1. Editor focused: keyboard → PTY (raw bytes), clicks in editor → PTY,
 *    clicks outside editor → switch focus to chat
 * 2. Chat focused: keyboard → ignored (Ink handles it), clicks in editor
 *    area → switch focus to editor
 *
 * Mouse SGR sequences are always parsed for focus routing.
 */

// SGR mouse: ESC [ < Btn ; Col ; Row [Mm]
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC required
const MOUSE_SGR_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/;

// SGR button codes
const BTN_LEFT = 0;

interface EditorInputOptions {
  ptyWrite: (data: string) => void;
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
 *
 * In PTY mode, raw stdin bytes are forwarded directly to the PTY
 * instead of being translated to vim key notation.
 */
export function useEditorInput({
  ptyWrite,
  isEditorFocused,
  isEditorVisible,
  onFocusChat,
  onFocusEditor,
  hasTabBar = true,
  editorSplit = 60,
}: EditorInputOptions): void {
  const ptyWriteRef = useRef(ptyWrite);
  ptyWriteRef.current = ptyWrite;
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
        const isPress = mouse[4] === "M";

        const editorWidth = getEditorWidthPx(process.stdout.columns ?? 120, editorSplitRef.current);
        const inEditor = termCol <= editorWidth;

        if (button === BTN_LEFT && isPress) {
          if (inEditor && !focusedRef.current) onFocusEditorRef.current();
          if (!inEditor && focusedRef.current) onFocusChatRef.current();
        }

        // Forward mouse SGR sequences directly to PTY when in editor area
        if (focusedRef.current && inEditor) {
          ptyWriteRef.current(seq);
        }
        return;
      }

      // Ctrl+Shift+E (CSI u) → bypass to Ink for focus switching
      if (seq === "\x1b[101;6u" || seq === "\x1b[69;6u") return;

      if (!focusedRef.current) return;

      // Ctrl+E → bypass to Ink (focus switching)
      if (buf.length === 1 && buf[0] === 0x05) return;
      // Ctrl+C → bypass to Ink
      if (buf.length === 1 && buf[0] === 0x03) return;

      // Forward raw bytes directly to PTY — no vim key translation needed
      ptyWriteRef.current(seq);
    };

    process.stdin.on("data", handler);
    return () => {
      process.stdin.removeListener("data", handler);
    };
  }, [isEditorVisible]);
}
