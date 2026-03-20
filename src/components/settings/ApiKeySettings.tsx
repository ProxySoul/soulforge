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

interface ApiKeyState {
  keys: Partial<Record<SecretKey, KeyInfo>>;
  refresh: () => void;
}

const PROVIDER_KEYS: SecretKey[] = [
  "anthropic-api-key",
  "openai-api-key",
  "google-api-key",
  "xai-api-key",
  "openrouter-api-key",
  "llmgateway-api-key",
  "vercel-gateway-api-key",
];

const useApiKeyStore = create<ApiKeyState>()((set) => ({
  keys: Object.fromEntries(PROVIDER_KEYS.map((k) => [k, hasSecret(k)])),
  refresh: () =>
    set({
      keys: Object.fromEntries(PROVIDER_KEYS.map((k) => [k, hasSecret(k)])),
    }),
}));

interface KeyItem {
  id: SecretKey;
  label: string;
  envVar: string;
  desc: string;
}

const KEY_ITEMS: KeyItem[] = [
  {
    id: "anthropic-api-key",
    label: "Anthropic",
    envVar: "ANTHROPIC_API_KEY",
    desc: "Claude models (claude-opus-4, claude-sonnet-4, ...)",
  },
  {
    id: "openai-api-key",
    label: "OpenAI",
    envVar: "OPENAI_API_KEY",
    desc: "GPT-4o, o3, o1 models",
  },
  {
    id: "google-api-key",
    label: "Google Gemini",
    envVar: "GOOGLE_GENERATIVE_AI_API_KEY",
    desc: "Gemini 2.5 Pro, Flash models",
  },
  {
    id: "xai-api-key",
    label: "xAI Grok",
    envVar: "XAI_API_KEY",
    desc: "Grok 3, Grok 3 Mini models",
  },
  {
    id: "openrouter-api-key",
    label: "OpenRouter",
    envVar: "OPENROUTER_API_KEY",
    desc: "Unified access to 300+ models",
  },
  {
    id: "llmgateway-api-key",
    label: "LLM Gateway",
    envVar: "LLM_GATEWAY_API_KEY",
    desc: "Gateway to multiple providers",
  },
  {
    id: "vercel-gateway-api-key",
    label: "Vercel AI Gateway",
    envVar: "AI_GATEWAY_API_KEY",
    desc: "Vercel-hosted AI Gateway",
  },
];

type MenuItem =
  | { type: "key"; item: KeyItem; info: KeyInfo }
  | { type: "action"; id: string; label: string; keyId: SecretKey };

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function ApiKeySettings({ visible, onClose }: Props) {
  const renderer = useRenderer();
  const { width: termCols, height: termRows } = useTerminalDimensions();
  const popupWidth = Math.min(MAX_POPUP_WIDTH, Math.floor(termCols * 0.75));
  const innerW = popupWidth - 2;
  const maxVisible = Math.max(4, Math.floor((termRows - 2) * 0.7) - CHROME_ROWS);

  const keys = useApiKeyStore((s) => s.keys);
  const refresh = useApiKeyStore((s) => s.refresh);
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<"menu" | "input">("menu");
  const [inputValue, setInputValue] = useState("");
  const [inputTarget, setInputTarget] = useState<SecretKey | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);

  useEffect(() => {
    if (visible) {
      refresh();
      setCursor(0);
      setScrollOffset(0);
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
      menuItems.push({
        type: "action",
        id: `remove:${k.id}`,
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

  // Clamp cursor and handle scroll
  const clampedCursor = Math.min(cursor, Math.max(0, menuItems.length - 1));
  const effectiveScrollOffset = Math.min(scrollOffset, Math.max(0, menuItems.length - maxVisible));
  const visibleItems = menuItems.slice(effectiveScrollOffset, effectiveScrollOffset + maxVisible);

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

    // Menu mode
    if (evt.name === "escape") {
      onClose();
      return;
    }
    if (evt.name === "up") {
      const next = clampedCursor > 0 ? clampedCursor - 1 : menuItems.length - 1;
      setCursor(next);
      if (next < effectiveScrollOffset) setScrollOffset(next);
      return;
    }
    if (evt.name === "down") {
      const next = clampedCursor < menuItems.length - 1 ? clampedCursor + 1 : 0;
      setCursor(next);
      if (next >= effectiveScrollOffset + maxVisible) {
        setScrollOffset(next - maxVisible + 1);
      }
      return;
    }
    if (evt.name === "return" || evt.name === " ") {
      const item = menuItems[clampedCursor];
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
  const configuredCount = KEY_ITEMS.filter((k) => keys[k.id]?.set).length;

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
              {icon("key") ?? ""}
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
        {/* Title */}
        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg="#9B30FF" attributes={TextAttributes.BOLD}>
            {icon("key") ?? ""}
          </text>
          <text bg={POPUP_BG} fg="white" attributes={TextAttributes.BOLD}>
            {" "}
            API Keys
          </text>
          <text bg={POPUP_BG} fg="#555">
            {`  ${String(configuredCount)}/${String(KEY_ITEMS.length)} configured`}
          </text>
        </PopupRow>

        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg="#333">
            {"─".repeat(innerW - 2)}
          </text>
        </PopupRow>

        {/* Key list */}
        {visibleItems.map((mi, idx) => {
          const absoluteIdx = effectiveScrollOffset + idx;
          const isSelected = absoluteIdx === clampedCursor;
          const bg = isSelected ? POPUP_HL : POPUP_BG;

          if (mi.type === "action") {
            return (
              <PopupRow key={mi.id} w={innerW}>
                <text bg={bg} fg={isSelected ? "#FF0040" : "#555"}>
                  {isSelected ? "›" : " "}
                  {"  "}
                  {mi.label.trimStart()}
                </text>
              </PopupRow>
            );
          }

          const info = mi.info;
          const item = mi.item;
          const statusColor = info.set ? "#2d5" : "#555";
          const statusText = info.set
            ? info.source === "env"
              ? `set (${item.envVar})`
              : `set (${info.source})`
            : "not set";

          return (
            <PopupRow key={item.id} w={innerW}>
              <text bg={bg} fg={isSelected ? "white" : "#ccc"}>
                {isSelected ? "›" : " "} {item.label}
              </text>
              <text bg={bg} fg={statusColor}>
                {" "}
                [{statusText}]
              </text>
            </PopupRow>
          );
        })}

        {/* Description for selected key item */}
        {(() => {
          const selected = menuItems[clampedCursor];
          if (selected?.type === "key") {
            return (
              <PopupRow w={innerW}>
                <text bg={POPUP_BG} fg="#555">
                  {"   "}
                  {selected.item.desc}
                </text>
              </PopupRow>
            );
          }
          return null;
        })()}

        {/* Scroll indicator */}
        {menuItems.length > maxVisible && (
          <PopupRow w={innerW}>
            <text bg={POPUP_BG} fg="#555">
              {`  ${String(effectiveScrollOffset + 1)}-${String(Math.min(effectiveScrollOffset + maxVisible, menuItems.length))}/${String(menuItems.length)}`}
            </text>
          </PopupRow>
        )}

        {/* Status message */}
        {statusMsg && (
          <PopupRow w={innerW}>
            <text bg={POPUP_BG} fg="#FF9500">
              {" "}
              {statusMsg}
            </text>
          </PopupRow>
        )}

        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg="#333">
            {"─".repeat(innerW - 2)}
          </text>
        </PopupRow>

        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg="#555">
            {"↑↓ navigate  ↵ set key  esc close"}
          </text>
        </PopupRow>

        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg="#555">
            {"Storage: "}
            {backendLabel}
          </text>
        </PopupRow>
      </box>
    </Overlay>
  );
}
