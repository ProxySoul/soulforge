import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useState } from "react";
import { TOOL_CATALOG } from "../../core/tools/constants.js";
import {
  buildGroupedRows,
  type GroupedItem,
  GroupedList,
  type GroupedListGroup,
  handleCursorNavKey,
  PremiumPopup,
  Section,
} from "../ui/index.js";

interface ToolItem extends GroupedItem {
  toolName: string;
}

interface Props {
  visible: boolean;
  disabledTools: Set<string>;
  onToggleTool: (name: string) => void;
  onClose: () => void;
}

export function ToolsPopup({ visible, disabledTools, onToggleTool, onClose }: Props) {
  const { width: tw, height: th } = useTerminalDimensions();
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    if (visible) setCursor(0);
  }, [visible]);

  const popupW = Math.min(110, Math.max(72, tw - 4));
  const popupH = Math.min(32, Math.max(16, th - 4));
  const contentW = popupW - 4;

  const groups = useMemo<GroupedListGroup<ToolItem>[]>(() => {
    return [
      {
        id: "tools",
        label: "Tools",
        hideHeader: true,
        items: Object.entries(TOOL_CATALOG).map(([name, desc]) => ({
          id: name,
          toolName: name,
          label: name,
          meta: desc,
          active: !disabledTools.has(name),
        })),
      },
    ];
  }, [disabledTools]);

  const rows = useMemo(() => buildGroupedRows(groups, new Set(["tools"])), [groups]);

  useKeyboard((evt) => {
    if (!visible) return;
    if (evt.name === "escape" || evt.name === "q") {
      onClose();
      return;
    }
    if (evt.name === "return" || evt.name === "space") {
      const r = rows[cursor];
      if (r?.kind === "item" && r.item) {
        onToggleTool((r.item as ToolItem).toolName);
      }
      return;
    }
    handleCursorNavKey(evt, setCursor, rows.length);
  });

  if (!visible) return null;

  const enabled = Object.keys(TOOL_CATALOG).filter((n) => !disabledTools.has(n)).length;
  const total = Object.keys(TOOL_CATALOG).length;

  return (
    <PremiumPopup
      visible={visible}
      width={popupW}
      height={popupH}
      title="Tools"
      titleIcon="tools"
      blurb={`${enabled} / ${total} enabled`}
      footerHints={[
        { key: "↑↓", label: "nav" },
        { key: "Space", label: "toggle" },
        { key: "Esc", label: "close" },
      ]}
    >
      <Section>
        <GroupedList
          groups={groups}
          expanded={new Set(["tools"])}
          selectedIndex={cursor}
          width={contentW}
          maxRows={Math.max(6, popupH - 9)}
        />
      </Section>
    </PremiumPopup>
  );
}
