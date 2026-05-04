import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useMemo, useState } from "react";
import { useTheme } from "../../core/theme/index.js";
import type { TaskRouter } from "../../types/index.js";
import type { ConfigScope } from "../layout/shared.js";
import { CONFIG_SCOPES } from "../layout/shared.js";
import {
  handleCursorNavKey,
  PremiumPopup,
  Section,
  SegmentedControl,
  VSpacer,
} from "../ui/index.js";

const BOLD = 1;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return `${s.slice(0, max - 1)}…`;
}

interface SlotDef {
  kind: "slot";
  key: keyof TaskRouter;
  label: string;
  icon: string;
  hint: string;
}

interface PickerDef {
  kind: "picker";
  key: "maxConcurrentAgents";
  label: string;
  icon: string;
  hint: string;
  options: number[];
  defaultValue: number;
}

type Def = SlotDef | PickerDef;

interface SectionDef {
  id: string;
  title: string;
  defs: Def[];
}

const SECTIONS: SectionDef[] = [
  {
    id: "main",
    title: "Main",
    defs: [
      {
        kind: "slot",
        key: "default",
        label: "Default",
        icon: "model",
        hint: "Conversation & fallback",
      },
    ],
  },
  {
    id: "dispatch",
    title: "Dispatch",
    defs: [
      { kind: "slot", key: "spark", label: "Explore", icon: "read_only", hint: "Read-only agents" },
      { kind: "slot", key: "ember", label: "Code", icon: "edit", hint: "Edit agents" },
      { kind: "slot", key: "webSearch", label: "Web", icon: "web", hint: "Web search & fetch" },
      {
        kind: "picker",
        key: "maxConcurrentAgents",
        label: "Concurrency",
        icon: "dispatch",
        hint: "Max parallel agents",
        options: [2, 3, 4, 5, 6, 7, 8],
        defaultValue: 3,
      },
    ],
  },
  {
    id: "post",
    title: "Post-Dispatch",
    defs: [
      {
        kind: "slot",
        key: "desloppify",
        label: "Cleanup",
        icon: "cleanup",
        hint: "Polish & style fixes",
      },
      { kind: "slot", key: "verify", label: "Review", icon: "review", hint: "Adversarial review" },
    ],
  },
  {
    id: "bg",
    title: "Background",
    defs: [
      {
        kind: "slot",
        key: "compact",
        label: "Compaction",
        icon: "compact_task",
        hint: "Summarize old context",
      },
      {
        kind: "slot",
        key: "semantic",
        label: "Soul Map",
        icon: "repomap",
        hint: "Symbol summaries",
      },
    ],
  },
];

const ALL_DEFS: Def[] = SECTIONS.flatMap((s) => s.defs);

interface Props {
  visible: boolean;
  router: TaskRouter | undefined;
  activeModel: string;
  scope: ConfigScope;
  onScopeChange: (toScope: ConfigScope, fromScope: ConfigScope) => void;
  onPickSlot: (slot: keyof TaskRouter) => void;
  onClearSlot: (slot: keyof TaskRouter) => void;
  onPickerChange: (key: "maxConcurrentAgents", value: number) => void;
  onClose: () => void;
}

export function RouterSettings({
  visible,
  router,
  activeModel,
  scope,
  onScopeChange,
  onPickSlot,
  onClearSlot,
  onPickerChange,
  onClose,
}: Props) {
  const t = useTheme();
  const { width: tw, height: th } = useTerminalDimensions();
  const [cursor, setCursor] = useState(0);

  const popupW = Math.min(100, Math.max(72, Math.floor(tw * 0.78)));
  const popupH = Math.min(40, Math.max(26, th - 4));
  const contentW = popupW - 4;

  // Flatten sections into navigable rows: [section header, slot, slot, …]
  type Row =
    | { kind: "header"; section: SectionDef }
    | { kind: "slot"; section: SectionDef; def: SlotDef };
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const s of SECTIONS) {
      out.push({ kind: "header", section: s });
      for (const d of s.defs) {
        if (d.kind === "slot") out.push({ kind: "slot", section: s, def: d });
      }
    }
    return out;
  }, []);

  // Find indices of slot rows so cursor only lands on slots.
  const slotIndices = useMemo(
    () => rows.map((r, i) => (r.kind === "slot" ? i : -1)).filter((i) => i >= 0),
    [rows],
  );

  const moveItem = (dir: 1 | -1) => {
    if (slotIndices.length === 0) return;
    const cur = slotIndices.indexOf(cursor);
    const base = cur < 0 ? 0 : cur;
    const nextPos = (base + dir + slotIndices.length) % slotIndices.length;
    setCursor(slotIndices[nextPos] ?? slotIndices[0] ?? 0);
  };

  // Initialize cursor on first slot
  useMemo(() => {
    if (cursor === 0 && slotIndices.length > 0 && slotIndices[0] !== 0) {
      setCursor(slotIndices[0] ?? 0);
    }
  }, [cursor, slotIndices]);

  const selectedRow = rows[cursor];
  const selectedDef = selectedRow?.kind === "slot" ? selectedRow.def : null;
  const pickerDefs = useMemo(() => ALL_DEFS.filter((d): d is PickerDef => d.kind === "picker"), []);

  useKeyboard((evt) => {
    if (!visible) return;

    if (evt.name === "escape" || evt.name === "q") {
      onClose();
      return;
    }

    if (evt.name === "up" || evt.name === "k") {
      moveItem(-1);
      return;
    }
    if (evt.name === "down" || evt.name === "j") {
      moveItem(1);
      return;
    }
    if (evt.name === "return") {
      if (selectedDef) onPickSlot(selectedDef.key);
      return;
    }
    if (evt.name === "d" || evt.name === "delete" || evt.name === "backspace") {
      if (selectedDef) onClearSlot(selectedDef.key);
      return;
    }
    if (evt.name === "left" || evt.name === "right") {
      // No picker selected (slots only) — left/right cycles config scope.
      // Concurrency picker is editable via its own SegmentedControl below.
      void onPickerChange;
      const sIdx = CONFIG_SCOPES.indexOf(scope);
      const next =
        evt.name === "left"
          ? CONFIG_SCOPES[(sIdx - 1 + CONFIG_SCOPES.length) % CONFIG_SCOPES.length]
          : CONFIG_SCOPES[(sIdx + 1) % CONFIG_SCOPES.length];
      if (next && next !== scope) onScopeChange(next, scope);
      return;
    }
    handleCursorNavKey(evt, setCursor, rows.length);
  });

  if (!visible) return null;

  const customCount = ALL_DEFS.filter(
    (d) => d.kind === "slot" && typeof router?.[d.key] === "string",
  ).length;
  const slotCount = ALL_DEFS.filter((d) => d.kind === "slot").length;

  // Columns: marker(2) + label + description + model (right)
  const labelCol = 12;
  const modelCol = Math.min(30, Math.max(18, Math.floor(contentW * 0.32)));
  const descCol = Math.max(8, contentW - 4 - labelCol - modelCol - 2);

  // Strip well-known provider prefix to keep model column compact.
  const shortModel = (m: string): string => {
    const slash = m.indexOf("/");
    return slash > 0 ? m.slice(slash + 1) : m;
  };

  return (
    <PremiumPopup
      visible={visible}
      width={popupW}
      height={popupH}
      title="Task Router"
      titleIcon="router"
      blurb={`${customCount}/${slotCount} set · ${scope} · default: ${shortModel(activeModel)}`}
      footerHints={[
        { key: "↑↓", label: "nav" },
        { key: "Enter", label: "set" },
        { key: "d", label: "reset" },
        { key: "←→", label: "scope" },
        { key: "Esc", label: "close" },
      ]}
    >
      <Section>
        <box flexDirection="column" backgroundColor={t.bgPopup}>
          {rows.map((row, idx) => {
            if (row.kind === "header") {
              return (
                <box
                  // biome-ignore lint/suspicious/noArrayIndexKey: stable row layout
                  key={`h-${idx}`}
                  flexDirection="column"
                  backgroundColor={t.bgPopup}
                >
                  {idx > 0 ? <box height={1} backgroundColor={t.bgPopup} /> : null}
                  <text bg={t.bgPopup} fg={t.brandAlt} attributes={BOLD}>
                    {row.section.title}
                  </text>
                </box>
              );
            }
            const isSelected = idx === cursor;
            const rowBg = isSelected ? t.bgPopupHighlight : t.bgPopup;
            const raw = router?.[row.def.key] ?? null;
            const modelId = typeof raw === "string" ? raw : null;
            const descFg = isSelected ? t.textSecondary : t.textMuted;
            const label = row.def.label.padEnd(labelCol).slice(0, labelCol);
            const desc = truncate(row.def.hint, descCol).padEnd(descCol).slice(0, descCol);
            return (
              <box
                // biome-ignore lint/suspicious/noArrayIndexKey: stable row layout
                key={`s-${idx}`}
                flexDirection="row"
                height={1}
                backgroundColor={rowBg}
              >
                <text bg={rowBg} fg={isSelected ? t.brandSecondary : t.textFaint} attributes={BOLD}>
                  {isSelected ? "▸ " : "  "}
                </text>
                <text bg={rowBg} fg={t.textPrimary} attributes={BOLD}>
                  {label}
                </text>
                <text bg={rowBg} fg={descFg}>
                  {desc}
                </text>
                <box flexGrow={1} backgroundColor={rowBg} />
                {modelId ? (
                  <text bg={rowBg} fg={t.brandAlt} attributes={BOLD}>
                    {truncate(shortModel(modelId), modelCol)}
                  </text>
                ) : (
                  <text bg={rowBg} fg={t.textDim}>
                    —
                  </text>
                )}
                <text bg={rowBg}>{"  "}</text>
              </box>
            );
          })}
        </box>
        <VSpacer />
        {pickerDefs.map((def) => {
          const cur = router?.[def.key];
          const num = typeof cur === "number" ? cur : def.defaultValue;
          return (
            <SegmentedControl
              key={def.key}
              label={def.label}
              labelWidth={14}
              options={def.options.map((o) => ({ value: o, label: String(o) }))}
              value={num}
            />
          );
        })}
        <VSpacer />
        <SegmentedControl
          label="Scope"
          labelWidth={14}
          options={CONFIG_SCOPES.map((s) => ({ value: s, label: s }))}
          value={scope}
        />
      </Section>
    </PremiumPopup>
  );
}
