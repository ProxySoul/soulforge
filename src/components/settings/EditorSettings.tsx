import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useState } from "react";
import type { AgentEditorAccess, EditorIntegration } from "../../types/index.js";
import type { ConfigScope } from "../layout/shared.js";
import { CONFIG_SCOPES } from "../layout/shared.js";
import {
  buildGroupedRows,
  type GroupedItem,
  GroupedList,
  type GroupedListGroup,
  Hint,
  handleCursorNavKey,
  PremiumPopup,
  Section,
  SegmentedControl,
  VSpacer,
} from "../ui/index.js";

const AGENT_ACCESS_MODES: AgentEditorAccess[] = ["on", "off", "when-open"];
const AGENT_ACCESS_LABELS: Record<AgentEditorAccess, string> = {
  on: "Always",
  off: "Never",
  "when-open": "When editor open",
};

interface FeatureKey {
  key: keyof EditorIntegration;
  label: string;
  desc: string;
}

const FEATURES: FeatureKey[] = [
  { key: "diagnostics", label: "LSP Diagnostics", desc: "errors & warnings from LSP" },
  { key: "symbols", label: "Document Symbols", desc: "functions, classes, variables" },
  { key: "hover", label: "Hover / Type Info", desc: "type info at cursor position" },
  { key: "references", label: "Find References", desc: "all usages of a symbol" },
  { key: "definition", label: "Go to Definition", desc: "jump to symbol definition" },
  { key: "codeActions", label: "Code Actions", desc: "quick fixes & refactorings" },
  { key: "rename", label: "LSP Rename", desc: "workspace-wide symbol rename" },
  { key: "lspStatus", label: "LSP Status", desc: "check attached LSP servers" },
  { key: "format", label: "LSP Format", desc: "format buffer via LSP" },
  { key: "editorContext", label: "Editor Context", desc: "file/cursor/selection in prompt" },
  {
    key: "syncEditorOnEdit",
    label: "Sync on Edit",
    desc: "jump to edited files (off = only refresh current)",
  },
];

const ALL_ON: EditorIntegration = {
  diagnostics: true,
  symbols: true,
  hover: true,
  references: true,
  definition: true,
  codeActions: true,
  editorContext: true,
  rename: true,
  lspStatus: true,
  format: true,
  syncEditorOnEdit: true,
};

const ALL_OFF: EditorIntegration = {
  diagnostics: false,
  symbols: false,
  hover: false,
  references: false,
  definition: false,
  codeActions: false,
  editorContext: false,
  rename: false,
  lspStatus: false,
  format: false,
  syncEditorOnEdit: false,
};

interface Props {
  visible: boolean;
  settings: EditorIntegration | undefined;
  initialScope?: ConfigScope;
  onUpdate: (settings: EditorIntegration, toScope: ConfigScope, fromScope?: ConfigScope) => void;
  onClose: () => void;
}

interface Row extends GroupedItem {
  fkey: keyof EditorIntegration;
}

export function EditorSettings({ visible, settings, initialScope, onUpdate, onClose }: Props) {
  const { width: tw, height: th } = useTerminalDimensions();
  const [cursor, setCursor] = useState(0);
  const [scope, setScope] = useState<ConfigScope>(initialScope ?? "project");

  const current = settings ?? ALL_ON;

  useEffect(() => {
    if (visible) {
      setScope(initialScope ?? "project");
      setCursor(0);
    }
  }, [visible, initialScope]);

  const popupW = Math.min(80, Math.max(64, Math.floor(tw * 0.7)));
  const popupH = Math.min(32, Math.max(20, th - 4));
  const contentW = popupW - 4;

  const groups = useMemo<GroupedListGroup<Row>[]>(
    () => [
      {
        id: "features",
        label: "Features",
        hideHeader: true,
        items: FEATURES.map((f) => ({
          id: f.key,
          fkey: f.key,
          label: f.label,
          meta: f.desc,
          active: !!current[f.key],
          keyHint: current[f.key] ? "✓" : " ",
        })),
      },
    ],
    [current],
  );

  const rows = useMemo(() => buildGroupedRows(groups, new Set(["features"])), [groups]);

  useKeyboard((evt) => {
    if (!visible) return;

    if (evt.name === "escape") {
      onClose();
      return;
    }
    if (evt.name === "return" || evt.name === "space") {
      const r = rows[cursor];
      if (r?.kind === "item" && r.item) {
        const k = (r.item as Row).fkey;
        onUpdate({ ...current, [k]: !current[k] }, scope);
      }
      return;
    }
    if (evt.name === "a") {
      onUpdate({ ...ALL_ON, agentAccess: current.agentAccess }, scope);
      return;
    }
    if (evt.name === "n") {
      onUpdate({ ...ALL_OFF, agentAccess: current.agentAccess }, scope);
      return;
    }
    if (evt.name === "e") {
      const currentAccess = current.agentAccess ?? "on";
      const idx = AGENT_ACCESS_MODES.indexOf(currentAccess);
      const next = AGENT_ACCESS_MODES[(idx + 1) % AGENT_ACCESS_MODES.length] ?? "on";
      onUpdate({ ...current, agentAccess: next }, scope);
      return;
    }
    if (evt.name === "left" || evt.name === "right") {
      setScope((prev) => {
        const idx = CONFIG_SCOPES.indexOf(prev);
        const next =
          evt.name === "left"
            ? CONFIG_SCOPES[(idx - 1 + CONFIG_SCOPES.length) % CONFIG_SCOPES.length]
            : CONFIG_SCOPES[(idx + 1) % CONFIG_SCOPES.length];
        if (next && next !== prev) onUpdate({ ...current }, next, prev);
        return next ?? prev;
      });
      return;
    }
    handleCursorNavKey(evt, setCursor, rows.length);
  });

  if (!visible) return null;

  const enabled = FEATURES.filter((f) => !!current[f.key]).length;
  const access = current.agentAccess ?? "on";

  return (
    <PremiumPopup
      visible={visible}
      width={popupW}
      height={popupH}
      title="Editor Integrations"
      titleIcon="editor"
      blurb={`${enabled} / ${FEATURES.length} enabled · scope: ${scope}`}
      footerHints={[
        { key: "↑↓", label: "nav" },
        { key: "Space", label: "toggle" },
        { key: "a/n", label: "all/none" },
        { key: "e", label: "agent access" },
        { key: "←→", label: "scope" },
        { key: "Esc", label: "close" },
      ]}
    >
      <Section>
        <GroupedList
          groups={groups}
          expanded={new Set(["features"])}
          selectedIndex={cursor}
          width={contentW}
          maxRows={Math.max(6, popupH - 14)}
        />
        <VSpacer />
        <SegmentedControl
          label="Agent access"
          labelWidth={14}
          options={AGENT_ACCESS_MODES.map((m) => ({ value: m, label: AGENT_ACCESS_LABELS[m] }))}
          value={access}
        />
        <SegmentedControl
          label="Scope"
          labelWidth={14}
          options={CONFIG_SCOPES.map((s) => ({ value: s, label: s }))}
          value={scope}
        />
        <VSpacer />
        <Hint>[a] enable all · [n] disable all · [e] cycle agent access · [←→] toggle scope</Hint>
      </Section>
    </PremiumPopup>
  );
}
