import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useMemo, useState } from "react";
import { useTheme } from "../../core/theme/index.js";
import type { TaskRouter } from "../../types/index.js";
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
  subtitle: string;
  defs: Def[];
}

const SECTIONS: SectionDef[] = [
  {
    id: "main",
    title: "Main Agent",
    subtitle: "Model that handles your conversation",
    defs: [
      {
        kind: "slot",
        key: "default",
        label: "Default",
        icon: "model",
        hint: "Fallback for background tasks when no specific model is set",
      },
    ],
  },
  {
    id: "dispatch",
    title: "Dispatch",
    subtitle: "Models for parallel subagents",
    defs: [
      {
        kind: "slot",
        key: "spark",
        label: "Explore",
        icon: "read_only",
        hint: "Read-only agents — searches, reads, analyzes",
      },
      {
        kind: "slot",
        key: "ember",
        label: "Code",
        icon: "edit",
        hint: "Edit agents — reads files, makes changes",
      },
      {
        kind: "slot",
        key: "webSearch",
        label: "Web",
        icon: "web",
        hint: "Searches the web & fetches pages",
      },
      {
        kind: "picker",
        key: "maxConcurrentAgents",
        label: "Concurrency",
        icon: "dispatch",
        hint: "Max parallel agents per dispatch (default 3)",
        options: [2, 3, 4, 5, 6, 7, 8],
        defaultValue: 3,
      },
    ],
  },
  {
    id: "post",
    title: "Post-Dispatch",
    subtitle: "Quality checks after code agents finish",
    defs: [
      {
        kind: "slot",
        key: "desloppify",
        label: "Cleanup",
        icon: "cleanup",
        hint: "Post-dispatch polish & style fixes",
      },
      {
        kind: "slot",
        key: "verify",
        label: "Review",
        icon: "review",
        hint: "Adversarial review after code agents",
      },
    ],
  },
  {
    id: "bg",
    title: "Background",
    subtitle: "Internal tasks — usually fine on defaults",
    defs: [
      {
        kind: "slot",
        key: "compact",
        label: "Compaction",
        icon: "compact_task",
        hint: "Summarizes old context when conversation grows long",
      },
      {
        kind: "slot",
        key: "semantic",
        label: "Soul Map",
        icon: "repomap",
        hint: "Generates symbol summaries for the repo map",
      },
    ],
  },
];

const ALL_DEFS: Def[] = SECTIONS.flatMap((s) => s.defs);

interface SlotRow extends GroupedItem {
  def: Def;
}

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
  const popupH = Math.min(36, Math.max(22, th - 4));
  const contentW = popupW - 4;

  const groups = useMemo<GroupedListGroup<SlotRow>[]>(() => {
    return SECTIONS.map((s) => ({
      id: s.id,
      label: s.title,
      accent: t.brandAlt,
      meta: s.subtitle,
      items: s.defs
        .filter((def) => def.kind === "slot")
        .map<SlotRow>((def) => {
          const raw = router?.[def.key] ?? null;
          const modelId = typeof raw === "string" ? raw : null;
          return {
            id: def.key,
            label: def.label,
            icon: def.icon,
            meta: modelId ?? `↳ ${activeModel}`,
            active: !!modelId,
            def,
          };
        }),
    }));
  }, [router, activeModel, t]);

  // Pickers are separate controls (SegmentedControl) rendered outside the list
  const pickerDefs = useMemo(() => ALL_DEFS.filter((d): d is PickerDef => d.kind === "picker"), []);

  const expanded = useMemo(() => new Set(groups.map((g) => g.id)), [groups]);
  const rows = useMemo(() => buildGroupedRows(groups, expanded), [groups, expanded]);

  const selectedRow = rows[cursor];
  const selectedDef = selectedRow?.kind === "item" ? (selectedRow.item as SlotRow).def : null;

  // Move cursor to next/prev item (skip group headers)
  const moveItem = (dir: 1 | -1) => {
    const total = rows.length;
    if (total === 0) return;
    let i = cursor + dir;
    for (let n = 0; n < total; n++) {
      if (i < 0) i = total - 1;
      else if (i >= total) i = 0;
      if (rows[i]?.kind === "item") {
        setCursor(i);
        return;
      }
      i += dir;
    }
  };

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
      if (selectedDef?.kind === "slot") onPickSlot(selectedDef.key);
      return;
    }
    if (evt.name === "d" || evt.name === "delete" || evt.name === "backspace") {
      if (selectedDef?.kind === "slot") onClearSlot(selectedDef.key);
      else if (selectedDef?.kind === "picker")
        onPickerChange(selectedDef.key, selectedDef.defaultValue);
      return;
    }
    if (evt.name === "left" || evt.name === "right") {
      if (selectedDef?.kind === "picker") {
        const cur = router?.[selectedDef.key] ?? selectedDef.defaultValue;
        const curNum = typeof cur === "number" ? cur : selectedDef.defaultValue;
        const idx = selectedDef.options.indexOf(curNum);
        const base = idx < 0 ? selectedDef.options.indexOf(selectedDef.defaultValue) : idx;
        const nextIdx =
          evt.name === "left"
            ? Math.max(0, base - 1)
            : Math.min(selectedDef.options.length - 1, base + 1);
        onPickerChange(selectedDef.key, selectedDef.options[nextIdx] ?? selectedDef.defaultValue);
        return;
      }
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

  return (
    <PremiumPopup
      visible={visible}
      width={popupW}
      height={popupH}
      title="Task Router"
      titleIcon="router"
      blurb={`${customCount} / ${slotCount} slots customized · scope: ${scope}`}
      footerHints={[
        { key: "↑↓", label: "nav" },
        { key: "Enter", label: "pick model" },
        { key: "d", label: "reset" },
        { key: "←→", label: "scope / value" },
        { key: "Esc", label: "close" },
      ]}
    >
      <Section>
        <GroupedList
          groups={groups}
          expanded={expanded}
          selectedIndex={cursor}
          width={contentW}
          maxRows={Math.max(6, popupH - 16)}
        />
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
        {selectedDef ? <Hint>{selectedDef.hint}</Hint> : null}
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
