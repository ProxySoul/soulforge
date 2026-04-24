import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { getGitLog, gitPull, gitPush, gitStash, gitStashPop } from "../../core/git/status.js";
import {
  buildGroupedRows,
  type GroupedItem,
  GroupedList,
  type GroupedListGroup,
  PremiumPopup,
  Section,
} from "../ui/index.js";

interface MenuItem extends GroupedItem {
  action: string;
}

const MENU_ITEMS: MenuItem[] = [
  { id: "commit", keyHint: "c", label: "Commit", meta: "open commit form", action: "commit" },
  { id: "push", keyHint: "p", label: "Push", meta: "git push", action: "push" },
  { id: "pull", keyHint: "u", label: "Pull", meta: "git pull", action: "pull" },
  { id: "stash", keyHint: "s", label: "Stash", meta: "stash uncommitted changes", action: "stash" },
  {
    id: "pop",
    keyHint: "o",
    label: "Stash Pop",
    meta: "restore latest stash",
    action: "stash-pop",
  },
  { id: "log", keyHint: "l", label: "Log", meta: "show recent commits", action: "log" },
  {
    id: "lazygit",
    keyHint: "g",
    label: "Lazygit",
    meta: "launch external lazygit",
    action: "lazygit",
  },
];

const GROUPS: GroupedListGroup<MenuItem>[] = [
  { id: "actions", label: "Actions", hideHeader: true, items: MENU_ITEMS },
];

interface Props {
  visible: boolean;
  cwd: string;
  onClose: () => void;
  onCommit: () => void;
  onSuspend: (opts: { command: string; args?: string[] }) => void;
  onSystemMessage: (msg: string) => void;
  onRefresh: () => void;
}

export function GitMenu({
  visible,
  cwd,
  onClose,
  onCommit,
  onSuspend,
  onSystemMessage,
  onRefresh,
}: Props) {
  const { width: tw } = useTerminalDimensions();
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const cursorRef = useRef(0);
  cursorRef.current = cursor;
  const busyRef = useRef(false);
  busyRef.current = busy;

  useEffect(() => {
    if (visible) setCursor(0);
  }, [visible]);

  const rows = buildGroupedRows(GROUPS, new Set(["actions"]));

  const run = async (action: string) => {
    switch (action) {
      case "commit":
        onClose();
        onCommit();
        return;
      case "push": {
        onClose();
        onSystemMessage("Pushing...");
        const r = await gitPush(cwd);
        onSystemMessage(r.ok ? "Push complete." : `Push failed: ${r.output}`);
        onRefresh();
        return;
      }
      case "pull": {
        onClose();
        onSystemMessage("Pulling...");
        const r = await gitPull(cwd);
        onSystemMessage(r.ok ? "Pull complete." : `Pull failed: ${r.output}`);
        onRefresh();
        return;
      }
      case "stash": {
        onClose();
        const r = await gitStash(cwd);
        onSystemMessage(r.ok ? "Changes stashed." : `Stash failed: ${r.output}`);
        onRefresh();
        return;
      }
      case "stash-pop": {
        onClose();
        const r = await gitStashPop(cwd);
        onSystemMessage(r.ok ? "Stash popped." : `Stash pop failed: ${r.output}`);
        onRefresh();
        return;
      }
      case "log": {
        onClose();
        const entries = await getGitLog(cwd, 20);
        if (entries.length === 0) onSystemMessage("No commits found.");
        else {
          onSystemMessage(entries.map((e) => `${e.hash} ${e.subject} (${e.date})`).join("\n"));
        }
        return;
      }
      case "lazygit": {
        onClose();
        try {
          onSuspend({ command: "lazygit" });
        } catch {
          onSystemMessage("Failed to launch lazygit. Is it installed?");
        }
        return;
      }
    }
  };

  useKeyboard((evt) => {
    if (!visible || busyRef.current) return;

    if (evt.name === "escape") {
      onClose();
      return;
    }
    if (evt.name === "return") {
      const r = rows[cursorRef.current];
      if (r?.kind === "item" && r.item) {
        setBusy(true);
        void run((r.item as MenuItem).action).finally(() => setBusy(false));
      }
      return;
    }
    if (evt.name === "up" || evt.name === "k") {
      setCursor((c) => (c > 0 ? c - 1 : MENU_ITEMS.length - 1));
      return;
    }
    if (evt.name === "down" || evt.name === "j") {
      setCursor((c) => (c < MENU_ITEMS.length - 1 ? c + 1 : 0));
      return;
    }
    // Mnemonic direct-invoke
    const hit = MENU_ITEMS.findIndex((m) => m.keyHint === evt.name);
    if (hit >= 0) {
      setCursor(hit);
      setBusy(true);
      const item = MENU_ITEMS[hit];
      if (item) void run(item.action).finally(() => setBusy(false));
    }
  });

  if (!visible) return null;

  const popupW = Math.min(60, Math.max(48, Math.floor(tw * 0.5)));

  return (
    <PremiumPopup
      visible={visible}
      width={popupW}
      height={16}
      title="Git"
      titleIcon="git"
      blurb={busy ? "Running…" : "Common git actions"}
      footerHints={[
        { key: "↑↓", label: "nav" },
        { key: "Enter", label: "run" },
        { key: "c/p/u/s/o/l/g", label: "direct" },
        { key: "Esc", label: "close" },
      ]}
    >
      <Section>
        <GroupedList
          groups={GROUPS}
          expanded={new Set(["actions"])}
          selectedIndex={cursor}
          width={popupW - 4}
        />
      </Section>
    </PremiumPopup>
  );
}
