import { decodePasteBytes, type PasteEvent } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import {
  deleteSecret,
  getStorageBackend,
  hasSecret,
  type SecretKey,
  setSecret,
} from "../../core/secrets.js";
import {
  buildGroupedRows,
  type GroupedItem,
  GroupedList,
  type GroupedListGroup,
  Hint,
  handleCursorNavKey,
  PremiumPopup,
  Search,
  Section,
  VSpacer,
} from "../ui/index.js";

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

interface Props {
  visible: boolean;
  onClose: () => void;
}

interface MenuRow extends GroupedItem {
  kind: "set" | "remove";
  targetKey: SecretKey;
}

export function WebSearchSettings({ visible, onClose }: Props) {
  const renderer = useRenderer();
  const { width: tw, height: th } = useTerminalDimensions();
  const keys = useWebSearchStore((s) => s.keys);
  const refresh = useWebSearchStore((s) => s.refresh);

  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<"menu" | "input">("menu");
  const [inputValue, setInputValue] = useState("");
  const [inputTarget, setInputTarget] = useState<SecretKey | null>(null);
  const [flash, setFlash] = useState<{ kind: "ok" | "err" | "info"; message: string } | null>(null);

  useEffect(() => {
    if (visible) {
      refresh();
      setCursor(0);
      setMode("menu");
      setFlash(null);
    }
  }, [visible, refresh]);

  useEffect(() => {
    if (!visible || mode !== "input") return;
    const handler = (event: PasteEvent) => {
      const cleaned = decodePasteBytes(event.bytes)
        .replace(/[\n\r]/g, "")
        .trim();
      if (cleaned) setInputValue((v) => v + cleaned);
    };
    renderer.keyInput.on("paste", handler);
    return () => {
      renderer.keyInput.off("paste", handler);
    };
  }, [visible, mode, renderer]);

  const popupW = Math.min(80, Math.max(64, Math.floor(tw * 0.65)));
  const popupH = Math.min(24, Math.max(16, th - 4));
  const contentW = popupW - 4;

  const groups = useMemo<GroupedListGroup<MenuRow>[]>(() => {
    const items: MenuRow[] = [];
    for (const k of KEY_ITEMS) {
      const info = keys[k.id];
      if (!info) continue;
      const status = info.set
        ? info.source === "env"
          ? `set (${k.envVar})`
          : `set (${info.source})`
        : "not set";
      items.push({
        id: k.id,
        kind: "set",
        targetKey: k.id,
        label: k.label,
        meta: status,
        active: info.set,
        status: info.set ? "online" : "offline",
      });
      if (info.set && info.source !== "env") {
        items.push({
          id: `${k.id}-remove`,
          kind: "remove",
          targetKey: k.id,
          label: `Remove ${k.label}`,
          meta: "deletes the stored secret",
          status: "error",
        });
      }
    }
    return [
      {
        id: "keys",
        label: "API keys",
        hideHeader: true,
        items,
      },
    ];
  }, [keys]);

  const rows = useMemo(() => buildGroupedRows(groups, new Set(["keys"])), [groups]);

  const popFlash = (kind: "ok" | "err" | "info", message: string) => {
    setFlash({ kind, message });
    setTimeout(() => setFlash(null), 2500);
  };

  const onSetKey = (target: SecretKey) => {
    const info = keys[target];
    if (info?.source === "env") {
      popFlash("info", "Set via env var — edit your shell config to change it.");
      return;
    }
    setInputTarget(target);
    setInputValue("");
    setMode("input");
  };

  const onConfirmInput = () => {
    if (!inputTarget || !inputValue.trim()) {
      setMode("menu");
      return;
    }
    const result = setSecret(inputTarget, inputValue.trim());
    if (result.success) {
      const where = result.storage === "keychain" ? "OS keychain" : (result.path ?? "secrets.json");
      popFlash("ok", `Saved to ${where}`);
    } else {
      popFlash("err", "Failed to save key");
    }
    refresh();
    setMode("menu");
    setInputValue("");
    setInputTarget(null);
  };

  const onRemoveKey = (keyId: SecretKey) => {
    const result = deleteSecret(keyId);
    if (result.success) popFlash("ok", `Removed from ${result.storage}`);
    else popFlash("err", "Key not found");
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
        onConfirmInput();
        return;
      }
      if (evt.name === "backspace") {
        setInputValue((v) => v.slice(0, -1));
        return;
      }
      const ch = evt.sequence;
      if (typeof ch === "string" && ch.length === 1 && ch >= " " && !evt.ctrl && !evt.meta) {
        setInputValue((v) => v + ch);
      }
      return;
    }

    if (evt.name === "escape") {
      onClose();
      return;
    }
    if (evt.name === "return" || evt.name === "space") {
      const r = rows[cursor];
      if (r?.kind === "item" && r.item) {
        const row = r.item as MenuRow;
        if (row.kind === "set") onSetKey(row.targetKey);
        else onRemoveKey(row.targetKey);
      }
      return;
    }
    handleCursorNavKey(evt, setCursor, rows.length);
  });

  if (!visible) return null;

  const hasBrave = keys["brave-api-key"]?.set ?? false;
  const hasJina = keys["jina-api-key"]?.set ?? false;
  const searchLabel = hasBrave ? "Brave" : "DuckDuckGo";
  const readerNote = hasJina ? "(500 RPM)" : "(20 RPM)";
  const backend = getStorageBackend();
  const backendLabel = backend === "keychain" ? "OS Keychain" : "~/.soulforge/secrets.json";

  if (mode === "input") {
    const target = KEY_ITEMS.find((k) => k.id === inputTarget);
    const masked =
      inputValue.length > 0
        ? `${"*".repeat(Math.max(0, inputValue.length - 4))}${inputValue.slice(-4)}`
        : "";
    return (
      <PremiumPopup
        visible={visible}
        width={popupW}
        height={10}
        title={target?.label ?? "API Key"}
        titleIcon="key"
        blurb="Paste your key"
        footerHints={[
          { key: "Enter", label: "save" },
          { key: "Esc", label: "cancel" },
        ]}
      >
        <Section>
          <Search value={masked} focused placeholder="Paste key here" icon="key" />
          <VSpacer />
          <Hint>Storage backend: {backendLabel}</Hint>
        </Section>
      </PremiumPopup>
    );
  }

  return (
    <PremiumPopup
      visible={visible}
      width={popupW}
      height={popupH}
      title="Web Search"
      titleIcon="web_search"
      blurb={`Search: ${searchLabel} · Reader: Jina ${readerNote}`}
      footerHints={[
        { key: "↑↓", label: "nav" },
        { key: "Enter", label: "set / remove" },
        { key: "Esc", label: "close" },
      ]}
      flash={flash}
    >
      <Section>
        <GroupedList
          groups={groups}
          expanded={new Set(["keys"])}
          selectedIndex={cursor}
          width={contentW}
          maxRows={Math.max(4, popupH - 10)}
        />
        <VSpacer />
        <Hint>Storage: {backendLabel}</Hint>
      </Section>
    </PremiumPopup>
  );
}
