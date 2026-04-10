import { decodePasteBytes, type PasteEvent } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useEffect, useState } from "react";
import { icon } from "../../core/icons.js";
import {
  getTerminalBuffer,
  onTerminalData,
  resizeTerminal,
  writeToTerminal,
} from "../../core/terminal/manager.js";
import { useTheme } from "../../core/theme/index.js";
import { useTerminalStore } from "../../stores/terminals.js";
import { useUIStore } from "../../stores/ui.js";
import { Overlay, POPUP_BG } from "./shared.js";

const MAX_PANEL_WIDTH = 100;

export function FloatingTerminal() {
  const t = useTheme();
  const renderer = useRenderer();
  const isOpen = useUIStore((s) => s.modals.floatingTerminal);
  const selectedId = useTerminalStore((s) => s.selectedId);
  const terminals = useTerminalStore((s) => s.terminals);
  const entry = terminals.find((e) => e.id === selectedId);
  const { width: termWidth, height: termHeight } = useTerminalDimensions();
  const [ansiBuffer, setAnsiBuffer] = useState<Uint8Array>(new Uint8Array(0));

  const panelWidth = Math.min(MAX_PANEL_WIDTH, Math.max(50, termWidth - 10));
  const panelHeight = Math.max(12, Math.floor(termHeight * 0.5));
  const innerWidth = panelWidth - 2;
  const termCols = Math.max(20, innerWidth - 2);
  const termRows = Math.max(5, panelHeight - 5);

  useEffect(() => {
    if (!isOpen || !selectedId) return;
    setAnsiBuffer(getTerminalBuffer(selectedId));
    return onTerminalData((id) => {
      if (id === selectedId) setAnsiBuffer(getTerminalBuffer(id));
    });
  }, [isOpen, selectedId]);

  useEffect(() => {
    if (!isOpen || !selectedId) return;
    resizeTerminal(selectedId, termCols, termRows);
  }, [isOpen, selectedId, termCols, termRows]);

  // Forward clipboard paste into the terminal shell
  useEffect(() => {
    if (!isOpen || !selectedId) return;
    const handler = (event: PasteEvent) => {
      const text = decodePasteBytes(event.bytes);
      if (text) writeToTerminal(selectedId, text);
    };
    renderer.keyInput.on("paste", handler);
    return () => {
      renderer.keyInput.off("paste", handler);
    };
  }, [isOpen, selectedId, renderer]);

  useKeyboard((key) => {
    if (!isOpen || !selectedId) return;

    if (key.name === "escape") {
      useUIStore.getState().closeModal("floatingTerminal");
      return;
    }

    if (key.ctrl) {
      const ch = key.name;
      if (ch === "c") {
        writeToTerminal(selectedId, "\x03");
        return;
      }
      if (ch === "d") {
        writeToTerminal(selectedId, "\x04");
        return;
      }
      if (ch === "l") {
        writeToTerminal(selectedId, "\x0c");
        return;
      }
      if (ch === "z") {
        writeToTerminal(selectedId, "\x1a");
        return;
      }
    }

    if (key.name === "return" || key.name === "enter") {
      writeToTerminal(selectedId, "\r");
      return;
    }
    if (key.name === "backspace") {
      writeToTerminal(selectedId, "\x7f");
      return;
    }
    if (key.name === "tab") {
      writeToTerminal(selectedId, "\t");
      return;
    }
    if (key.name === "up") {
      writeToTerminal(selectedId, "\x1b[A");
      return;
    }
    if (key.name === "down") {
      writeToTerminal(selectedId, "\x1b[B");
      return;
    }
    if (key.name === "right") {
      writeToTerminal(selectedId, "\x1b[C");
      return;
    }
    if (key.name === "left") {
      writeToTerminal(selectedId, "\x1b[D");
      return;
    }
    if (key.name === "home") {
      writeToTerminal(selectedId, "\x1b[H");
      return;
    }
    if (key.name === "end") {
      writeToTerminal(selectedId, "\x1b[F");
      return;
    }
    if (key.name === "delete") {
      writeToTerminal(selectedId, "\x1b[3~");
      return;
    }
    if (key.name === "pageup") {
      writeToTerminal(selectedId, "\x1b[5~");
      return;
    }
    if (key.name === "pagedown") {
      writeToTerminal(selectedId, "\x1b[6~");
      return;
    }

    if (key.sequence) {
      writeToTerminal(selectedId, key.sequence);
    }
  });

  if (!isOpen || !entry) return null;

  const statusColor = entry.active ? t.success : t.error;
  const statusDot = entry.active ? "●" : "○";

  return (
    <Overlay>
      <box
        width={panelWidth}
        height={panelHeight}
        flexDirection="column"
        borderStyle="rounded"
        border={true}
        borderColor={t.brand}
        backgroundColor={POPUP_BG}
      >
        <box height={1} flexShrink={0} paddingX={1} marginTop={-1}>
          <text bg={POPUP_BG} truncate>
            <span fg={statusColor}>{statusDot} </span>
            <span fg={t.brand}>{icon("terminal")} </span>
            <span fg={t.textPrimary}>
              #{String(entry.id)} {entry.label}
            </span>
            <span fg={t.textFaint}> [{String(entry.pid ?? "?")}]</span>
            <span fg={t.textDim}> {entry.cwd}</span>
          </text>
        </box>
        <box height={1} flexShrink={0}>
          <text bg={POPUP_BG}>
            <span fg={t.textFaint}>{"─".repeat(innerWidth)}</span>
          </text>
        </box>
        <box height={termRows} flexDirection="column" backgroundColor={POPUP_BG}>
          {ansiBuffer.byteLength > 0 ? (
            <ghostty-terminal ansi={ansiBuffer} showCursor cols={termCols} rows={termRows} />
          ) : (
            <box paddingX={2}>
              <text bg={POPUP_BG} fg={t.textDim}>
                Shell starting...
              </text>
            </box>
          )}
        </box>
        <box height={1} flexShrink={0} paddingX={1}>
          <text bg={POPUP_BG}>
            {entry.active ? (
              <span fg={t.textDim}>Esc hide</span>
            ) : (
              <span fg={t.textDim}>[process exited] Esc hide</span>
            )}
          </text>
        </box>
      </box>
    </Overlay>
  );
}
