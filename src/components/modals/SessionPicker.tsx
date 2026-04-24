/**
 * SessionPicker — saved-session browser.
 *
 * Features:
 *  - Table of sessions (title · msgs · size · updated)
 *  - Live filter by title (type to search)
 *  - Ctrl+R rename (inline edit mode)
 *  - Ctrl+D delete selected
 *  - Ctrl+X clear all (with y/n confirmation)
 */

import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type SessionListEntry, SessionManager } from "../../core/sessions/manager.js";
import { useTheme } from "../../core/theme/index.js";
import { timeAgo } from "../../utils/time.js";
import { Spinner } from "../layout/shared.js";
import {
  Hint,
  PremiumPopup,
  Search,
  Section,
  Table,
  type TableColumn,
  VSpacer,
} from "../ui/index.js";

interface Props {
  visible: boolean;
  cwd: string;
  onClose: () => void;
  onRestore: (sessionId: string) => void;
  onSystemMessage: (msg: string) => void;
}

interface SessionRow {
  id: string;
  title: string;
  msgs: number;
  size: number;
  sizeLabel: string;
  updatedLabel: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)}K`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)}M`;
  return `${(mb / 1024).toFixed(1)}G`;
}

function toRow(e: SessionListEntry): SessionRow {
  return {
    id: e.id,
    title: e.title.replace(/[\n\r]+/g, " "),
    msgs: e.messageCount,
    size: e.sizeBytes,
    sizeLabel: formatSize(e.sizeBytes),
    updatedLabel: timeAgo(e.updatedAt),
  };
}

const COLUMNS: TableColumn<SessionRow>[] = [
  { key: "title" },
  { key: "msgs", width: 6, align: "right" },
  { key: "size", width: 7, align: "right", render: (r) => r.sizeLabel },
  { key: "updated", width: 12, align: "right", render: (r) => r.updatedLabel },
];

export function SessionPicker({ visible, cwd, onClose, onRestore, onSystemMessage }: Props) {
  const t = useTheme();
  const { width: tw, height: th } = useTerminalDimensions();

  const popupW = Math.min(110, Math.max(80, Math.floor(tw * 0.8)));
  const popupH = Math.min(34, Math.max(18, th - 4));
  const contentW = popupW - 4;

  const [sessions, setSessions] = useState<SessionListEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [flash, setFlash] = useState<{ kind: "ok" | "err" | "info"; message: string } | null>(null);

  const cursorRef = useRef(0);
  cursorRef.current = cursor;

  const manager = useMemo(() => new SessionManager(cwd), [cwd]);

  const refresh = useCallback(() => {
    const mgr = new SessionManager(cwd);
    setLoading(true);
    mgr
      .listSessionsAsync()
      .then(setSessions)
      .catch(() => setSessions(mgr.listSessions()))
      .finally(() => setLoading(false));
  }, [cwd]);

  useEffect(() => {
    if (!visible) return;
    setQuery("");
    setCursor(0);
    setConfirmClear(false);
    setRenameId(null);
    setFlash(null);
    refresh();
  }, [visible, refresh]);

  const filtered = useMemo(() => {
    const fq = query.toLowerCase().trim();
    const rows = sessions.map(toRow);
    return fq ? rows.filter((r) => r.title.toLowerCase().includes(fq)) : rows;
  }, [sessions, query]);

  // Clamp cursor when filter narrows
  useEffect(() => {
    if (cursor >= filtered.length && filtered.length > 0) setCursor(filtered.length - 1);
  }, [filtered.length, cursor]);

  const popFlash = (kind: "ok" | "err" | "info", message: string) => {
    setFlash({ kind, message });
    setTimeout(() => setFlash(null), 2000);
  };

  useKeyboard((evt) => {
    if (!visible) return;

    // Rename mode — absorbs keystrokes
    if (renameId) {
      if (evt.name === "escape") {
        setRenameId(null);
        return;
      }
      if (evt.name === "return") {
        const trimmed = renameValue.trim();
        if (trimmed) {
          manager.renameSession(renameId, trimmed);
          onSystemMessage(`Renamed session to: ${trimmed}`);
          popFlash("ok", `Renamed`);
          refresh();
        }
        setRenameId(null);
        return;
      }
      if (evt.name === "backspace" || evt.name === "delete") {
        setRenameValue((p) => p.slice(0, -1));
        return;
      }
      const ch = evt.sequence;
      if (typeof ch === "string" && ch.length === 1 && ch >= " " && !evt.ctrl && !evt.meta) {
        setRenameValue((p) => p + ch);
      }
      return;
    }

    // Confirm-clear mode
    if (confirmClear) {
      if (evt.name === "y") {
        const count = manager.clearAllSessions();
        onSystemMessage(`Cleared ${count} session(s).`);
        popFlash("ok", `Cleared ${count} sessions`);
        setConfirmClear(false);
        refresh();
      } else {
        setConfirmClear(false);
      }
      return;
    }

    if (evt.name === "escape") {
      onClose();
      return;
    }
    if (evt.name === "up") {
      setCursor((c) => (c > 0 ? c - 1 : Math.max(0, filtered.length - 1)));
      return;
    }
    if (evt.name === "down") {
      setCursor((c) => (c < filtered.length - 1 ? c + 1 : 0));
      return;
    }
    if (evt.name === "return") {
      const s = filtered[cursorRef.current];
      if (s) {
        onRestore(s.id);
        onClose();
      }
      return;
    }
    if (evt.ctrl && evt.name === "d") {
      const s = filtered[cursorRef.current];
      if (s) {
        manager.deleteSession(s.id);
        onSystemMessage(`Deleted session: ${s.title}`);
        popFlash("ok", `Deleted ${s.title}`);
        refresh();
      }
      return;
    }
    if (evt.ctrl && evt.name === "r") {
      const s = filtered[cursorRef.current];
      if (s) {
        setRenameId(s.id);
        setRenameValue(s.title);
      }
      return;
    }
    if (evt.ctrl && evt.name === "x") {
      if (sessions.length > 0) setConfirmClear(true);
      return;
    }
    if (evt.name === "backspace" || evt.name === "delete") {
      setQuery((p) => p.slice(0, -1));
      return;
    }
    if (evt.ctrl && evt.name === "u") {
      setQuery("");
      return;
    }
    const ch = evt.sequence;
    if (typeof ch === "string" && ch.length === 1 && ch >= " " && !evt.ctrl && !evt.meta) {
      setQuery((p) => p + ch);
    }
  });

  if (!visible) return null;

  const totalSize = sessions.reduce((s, x) => s + x.sizeBytes, 0);
  const blurb = query
    ? `${filtered.length} of ${sessions.length} sessions`
    : sessions.length > 0
      ? `${sessions.length} sessions · ${formatSize(totalSize)} on disk`
      : "No sessions yet";

  return (
    <PremiumPopup
      visible={visible}
      width={popupW}
      height={popupH}
      title="Sessions"
      titleIcon="clock_alt"
      blurb={blurb}
      footerHints={
        renameId
          ? [
              { key: "type", label: "rename" },
              { key: "Enter", label: "save" },
              { key: "Esc", label: "cancel" },
            ]
          : confirmClear
            ? [
                { key: "y", label: "confirm" },
                { key: "any", label: "cancel" },
              ]
            : [
                { key: "↑↓", label: "nav" },
                { key: "Enter", label: "restore" },
                { key: "^R", label: "rename" },
                { key: "^D", label: "delete" },
                { key: "^X", label: "clear all" },
                { key: "Esc", label: "close" },
              ]
      }
      flash={flash}
    >
      <Section>
        <Search
          value={query}
          focused={!renameId && !confirmClear}
          placeholder="Type to filter by title…"
          count={query ? `${filtered.length} / ${sessions.length}` : undefined}
        />
        <VSpacer />
        {loading && sessions.length === 0 ? (
          <box flexDirection="row" paddingX={2} paddingY={1}>
            <Spinner color={t.brand} />
            <text bg={t.bgPopup} fg={t.textMuted}>
              {"  "}
              Loading sessions…
            </text>
          </box>
        ) : (
          <Table
            columns={COLUMNS}
            rows={filtered}
            width={contentW}
            selectedIndex={renameId || confirmClear ? -1 : cursor}
            focused={!renameId && !confirmClear}
            maxRows={Math.max(5, popupH - 14)}
            emptyMessage={query ? "No matching sessions" : "No sessions yet — start chatting!"}
          />
        )}
        {renameId ? (
          <>
            <VSpacer />
            <box flexDirection="row" paddingX={2} backgroundColor={t.bgPopup}>
              <text bg={t.bgPopup} fg={t.brand} attributes={1 /* BOLD */}>
                Rename:{" "}
              </text>
              <text bg={t.bgPopup} fg={t.textPrimary}>
                {renameValue}
              </text>
              <text bg={t.bgPopup} fg={t.brandSecondary} attributes={1 /* BOLD */}>
                ▎
              </text>
            </box>
          </>
        ) : null}
        {confirmClear ? (
          <>
            <VSpacer />
            <Hint kind="warn">
              Delete all {sessions.length} sessions? Press [y] to confirm, any other key to cancel.
            </Hint>
          </>
        ) : null}
      </Section>
    </PremiumPopup>
  );
}
