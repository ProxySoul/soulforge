import { TextAttributes } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { icon } from "../../core/icons.js";
import {
  deleteSecret,
  getStorageBackend,
  hasSecret,
  type SecretKey,
  setSecret,
} from "../../core/secrets.js";
import { Overlay, POPUP_BG, POPUP_HL, PopupRow } from "../layout/shared.js";

const MAX_POPUP_WIDTH = 62;
const CHROME_ROWS = 10;

interface KeyInfo {
  set: boolean;
  source: "env" | "keychain" | "file" | "none";
}

interface WebSearchState {
  keys: Partial<Record<SecretKey, KeyInfo>>;
  refresh: () => void;
}

const useWebSearchStore = create<WebSearchState>()((set) => ({
  keys: {
    "brave-api-key": hasSecret("brave-api-key"),
    "jina-api-key": hasSecret("jina-api-key"),
  },
  refresh: () =>
    set({
      keys: {
        "brave-api-key": hasSecret("brave-api-key"),
        "jina-api-key": hasSecret("jina-api-key"),
      },
    }),
}));

type Mode = "menu" | "input";

interface KeyItem {
  id: SecretKey;
  label: string;
  envVar: string;
  desc: string;
}

const KEY_ITEMS: KeyItem[] = [
  {
    id: "brave-api-key",
    label: "Brave Search API Key",
    envVar: "BRAVE_SEARCH_API_KEY",
    desc: "Better search results (free: 2k queries/mo)",
  },
  {
    id: "jina-api-key",
    label: "Jina Reader API Key",
    envVar: "JINA_API_KEY",
    desc: "Faster page reading (free: 10M tokens)",
  },
];

type MenuItem =
  | { type: "key"; item: KeyItem; info: KeyInfo }
  | { type: "action"; id: "remove-brave" | "remove-jina"; label: string; keyId: SecretKey };

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function WebSearchSettings({ visible, onClose }: Props) {
  const renderer = useRenderer();
  const { width: termCols, height: termRows } = useTerminalDimensions();
  const popupWidth = Math.min(MAX_POPUP_WIDTH, Math.floor(termCols * 0.75));
  const innerW = popupWidth - 2;
  const maxVisible = Math.max(4, Math.floor((termRows - 2) * 0.7) - CHROME_ROWS);

  const keys = useWebSearchStore((s) => s.keys);
  const refresh = useWebSearchStore((s) => s.refresh);
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<Mode>("menu");
  const [inputValue, setInputValue] = useState("");
  const [inputTarget, setInputTarget] = useState<SecretKey | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      refresh();
      setCursor(0);
      setMode("menu");
      setStatusMsg(null);
    }
  }, [visible, refresh]);

  useEffect(() => {
    if (!visible || mode !== "input") return;
    const handler = (event: { text: string }) => {
      const cleaned = event.text.replace(/[\n\r]/g, "").trim();
      if (cleaned) setInputValue((v) => v + cleaned);
    };
    renderer.keyInput.on("paste", handler);
    return () => {
      renderer.keyInput.off("paste", handler);
    };
  }, [visible, mode, renderer]);

  const menuItems: MenuItem[] = [];
  for (const k of KEY_ITEMS) {
    const info = keys[k.id];
    if (!info) continue;
    menuItems.push({ type: "key", item: k, info });
    if (info.set && info.source !== "env") {
      const removeId = k.id === "brave-api-key" ? "remove-brave" : "remove-jina";
      menuItems.push({
        type: "action",
        id: removeId as "remove-brave" | "remove-jina",
        label: `  Remove ${k.label}`,
        keyId: k.id,
      });
    }
  }

  const flash = (msg: string) => {
    setStatusMsg(msg);
    setTimeout(() => setStatusMsg(null), 3000);
  };

  const handleSetKey = (target: SecretKey) => {
    const info = keys[target];
    if (info?.source === "env") {
      flash("Set via env var — edit your shell config to change it.");
      return;
    }
    setInputTarget(target);
    setInputValue("");
    setMode("input");
  };

  const handleConfirmInput = () => {
    if (!inputTarget || !inputValue.trim()) {
      setMode("menu");
      return;
    }
    const result = setSecret(inputTarget, inputValue.trim());
    if (result.success) {
      const where =
        result.storage === "keychain"
          ? "OS keychain"
          : (result.path ?? "~/.soulforge/secrets.json");
      flash(`Saved to ${where}`);
    } else {
      flash("Failed to save key");
    }
    refresh();
    setMode("menu");
    setInputValue("");
    setInputTarget(null);
  };

  const handleRemoveKey = (keyId: SecretKey) => {
    const result = deleteSecret(keyId);
    if (result.success) {
      flash(`Removed from ${result.storage}`);
    } else {
      flash("Key not found");
    }
    refresh();
  };

  useKeyboard((evt) => {
    if (!visible) return;

    if (mode === "input") {
      if (evt.name === "escape") {
        setMode("menu");
        setInputValue("");
        setInputTarget(null);
        return;
      }
      if (evt.name === "return") {
        handleConfirmInput();
        return;
      }
      if (evt.name === "backspace") {
        setInputValue((v) => v.slice(0, -1));
        return;
      }
      if (evt.sequence && evt.sequence.length === 1 && !evt.ctrl && !evt.meta) {
        setInputValue((v) => v + evt.sequence);
      }
      return;
    }

    if (evt.name === "escape") {
      onClose();
      return;
    }
    if (evt.name === "up") {
      setCursor((c) => (c > 0 ? c - 1 : menuItems.length - 1));
      return;
    }
    if (evt.name === "down") {
      setCursor((c) => (c < menuItems.length - 1 ? c + 1 : 0));
      return;
    }
    if (evt.name === "return" || evt.name === " ") {
      const item = menuItems[cursor];
      if (!item) return;
      if (item.type === "key") {
        handleSetKey(item.item.id);
      } else if (item.type === "action") {
        handleRemoveKey(item.keyId);
      }
    }
  });

  if (!visible) return null;

  const backend = getStorageBackend();
  const backendLabel = backend === "keychain" ? "OS Keychain" : "~/.soulforge/secrets.json";

  const hasBrave = keys["brave-api-key"]?.set ?? false;
  const hasJina = keys["jina-api-key"]?.set ?? false;
  const searchLabel = hasBrave ? "Brave Search" : "DuckDuckGo";
  const searchNote = hasBrave ? "(API key set)" : "(free, no key)";
  const readerLabel = "Jina Reader";
  const readerNote = hasJina ? "(API key set, 500 RPM)" : "(free, 20 RPM)";

  if (mode === "input") {
    const target = KEY_ITEMS.find((k) => k.id === inputTarget);
    const masked =
      inputValue.length > 0
        ? `${"*".repeat(Math.max(0, inputValue.length - 4))}${inputValue.slice(-4)}`
        : "";

    return (
      <Overlay>
        <box
          flexDirection="column"
          borderStyle="rounded"
          border={true}
          borderColor="#8B5CF6"
          width={popupWidth}
        >
          <PopupRow w={innerW}>
            <text bg={POPUP_BG} fg="#9B30FF" attributes={TextAttributes.BOLD}>
              {icon("proxy")}
            </text>
            <text bg={POPUP_BG} fg="white" attributes={TextAttributes.BOLD}>
              {" "}
              {target?.label ?? "API Key"}
            </text>
          </PopupRow>

          <PopupRow w={innerW}>
            <text bg={POPUP_BG} fg="#333">
              {"─".repeat(innerW - 2)}
            </text>
          </PopupRow>

          <PopupRow w={innerW}>
            <text bg={POPUP_BG} fg="#888">
              Paste your key:
            </text>
          </PopupRow>

          <PopupRow w={innerW}>
            <text bg="#1a1a2e" fg="#8B5CF6">
              {masked || " "}
            </text>
            <text bg="#1a1a2e" fg="#FF0040">
              _
            </text>
          </PopupRow>

          <PopupRow w={innerW}>
            <text bg={POPUP_BG} fg="#333">
              {"─".repeat(innerW - 2)}
            </text>
          </PopupRow>

          <PopupRow w={innerW}>
            <text bg={POPUP_BG} fg="#555">
              {"⏎"} save | esc cancel | stored in {backendLabel}
            </text>
          </PopupRow>
        </box>
      </Overlay>
    );
  }

  return (
    <Overlay>
      <box
        flexDirection="column"
        borderStyle="rounded"
        border={true}
        borderColor="#8B5CF6"
        width={popupWidth}
      >
        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg="#9B30FF" attributes={TextAttributes.BOLD}>
            {icon("web_search")}
          </text>
          <text bg={POPUP_BG} fg="white" attributes={TextAttributes.BOLD}>
            {" "}
            Web Search
          </text>
        </PopupRow>

        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg="#333">
            {"─".repeat(innerW - 2)}
          </text>
        </PopupRow>

        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg="#888">
            {"Search: "}
          </text>
          <text bg={POPUP_BG} fg={hasBrave ? "#2d5" : "#888"}>
            {searchLabel}
          </text>
          <text bg={POPUP_BG} fg="#555">
            {" "}
            {searchNote}
          </text>
        </PopupRow>
        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg="#888">
            {"Reader: "}
          </text>
          <text bg={POPUP_BG} fg={hasJina ? "#2d5" : "#888"}>
            {readerLabel}
          </text>
          <text bg={POPUP_BG} fg="#555">
            {" "}
            {readerNote}
          </text>
        </PopupRow>

        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg="#333">
            {"─".repeat(innerW - 2)}
          </text>
        </PopupRow>

        <box
          flexDirection="column"
          height={Math.min(menuItems.length, maxVisible)}
          overflow="hidden"
        >
          {menuItems.map((mi, i) => {
            const isSelected = i === cursor;
            const bg = isSelected ? POPUP_HL : POPUP_BG;

            if (mi.type === "action") {
              return (
                <PopupRow key={mi.id} bg={bg} w={innerW}>
                  <text bg={bg} fg={isSelected ? "#FF0040" : "#555"}>
                    {isSelected ? "› " : "  "}
                  </text>
                  <text bg={bg} fg="#e55">
                    {mi.label}
                  </text>
                </PopupRow>
              );
            }

            const info = mi.info;
            const statusColor = info.set ? "#2d5" : "#555";
            const statusText = info.set
              ? info.source === "env"
                ? `set (${mi.item.envVar})`
                : `set (${info.source})`
              : "not set";

            return (
              <PopupRow key={mi.item.id} bg={bg} w={innerW}>
                <text bg={bg} fg={isSelected ? "#FF0040" : "#555"}>
                  {isSelected ? "› " : "  "}
                </text>
                <text bg={bg} fg="white">
                  {mi.item.label}
                </text>
                <text bg={bg} fg={statusColor}>
                  {" "}
                  [{statusText}]
                </text>
              </PopupRow>
            );
          })}
        </box>

        {(() => {
          const mi = menuItems[cursor];
          if (mi?.type === "key") {
            return (
              <PopupRow w={innerW}>
                <text bg={POPUP_BG} fg="#666">
                  {"  "}
                  {mi.item.desc}
                </text>
              </PopupRow>
            );
          }
          return null;
        })()}

        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg="#333">
            {"─".repeat(innerW - 2)}
          </text>
        </PopupRow>

        {statusMsg ? (
          <PopupRow w={innerW}>
            <text bg={POPUP_BG} fg="#8B5CF6">
              {statusMsg}
            </text>
          </PopupRow>
        ) : (
          <PopupRow w={innerW}>
            <text bg={POPUP_BG} fg="#555">
              Storage: {backendLabel}
            </text>
          </PopupRow>
        )}

        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg="#555">
            {"↑↓"} nav | {"⏎"} set key | esc close
          </text>
        </PopupRow>
      </box>
    </Overlay>
  );
}
