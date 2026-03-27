import { useTerminalDimensions } from "@opentui/react";
import { icon } from "../../core/icons.js";

// Priority tiers: 1 = always show, 2 = medium+, 3 = wide only
interface ShortcutDef {
  k: string;
  ic: string;
  l: string;
  tier: 1 | 2 | 3;
}

const SHORTCUTS: ShortcutDef[] = [
  { k: "^X", ic: icon("stop"), l: "Stop", tier: 1 },
  { k: "^K", ic: icon("lightning"), l: "Palette", tier: 1 },
  { k: "^L", ic: icon("brain_alt"), l: "LLM", tier: 1 },
  { k: "^G", ic: icon("git"), l: "Git", tier: 1 },
  { k: "^E", ic: icon("pencil"), l: "Editor", tier: 2 },
  { k: "^D", ic: icon("cog"), l: "Mode", tier: 2 },
  { k: "^S", ic: icon("skills"), l: "Skills", tier: 2 },
  { k: "^N", ic: icon("ghost"), l: "New Session", tier: 3 },
  { k: "^P", ic: icon("clock_alt"), l: "Sessions", tier: 3 },
  { k: "^T", ic: icon("tabs"), l: "Tab", tier: 3 },
  { k: "^C", ic: icon("quit"), l: "Quit", tier: 1 },
];

export function Footer() {
  const { width } = useTerminalDimensions();

  const maxTier = width >= 100 ? 3 : width >= 70 ? 2 : 1;
  const showLabels = width >= 50;
  const visible = SHORTCUTS.filter((s) => s.tier <= maxTier);

  return (
    <box
      flexDirection="row"
      justifyContent="center"
      paddingX={1}
      width="100%"
      gap={showLabels ? 2 : 1}
    >
      {visible.map((s) => (
        <text key={s.k}>
          <span fg="#666">
            <b>{s.k}</b>
          </span>
          <span fg="#444">
            {" "}
            {s.ic}
            {showLabels ? ` ${s.l}` : ""}
          </span>
        </text>
      ))}
    </box>
  );
}
