import { RGBA, TextAttributes, type TextChunk, type TextTableContent } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { icon } from "../../core/icons.js";
import { type SessionListEntry, SessionManager } from "../../core/sessions/manager.js";
import { useTheme } from "../../core/theme/index.js";
import { usePopupScroll } from "../../hooks/usePopupScroll.js";
import { timeAgo } from "../../utils/time.js";
import { POPUP_BG, Popup, PopupRow, Spinner } from "../layout/shared.js";

const POPUP_CHROME = 8;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)}K`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)}M`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)}G`;
}

function chunk(text: string, color?: string, attrs?: number): TextChunk {
  const c: TextChunk = { __isChunk: true, text };
  if (color) c.fg = RGBA.fromHex(color);
  if (attrs) c.attributes = attrs;
  return c;
}

interface Props {
  visible: boolean;
  cwd: string;
  onClose: () => void;
  onRestore: (sessionId: string) => void;
  onSystemMessage: (msg: string) => void;
}

export function SessionPicker({ visible, cwd, onClose, onRestore, onSystemMessage }: Props) {
  const t = useTheme();
  const [sessions, setSessions] = useState<SessionListEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const { width: termCols, height: termRows } = useTerminalDimensions();

  const containerRows = termRows - 2;
  const popupWidth = Math.min(90, Math.floor(termCols * 0.85));
  const maxVisible = Math.max(3, Math.floor(containerRows * 0.8) - POPUP_CHROME);
  const innerW = popupWidth - 2;
  const { cursor, setCursor, scrollOffset, adjustScroll, resetScroll } = usePopupScroll(maxVisible);

  const manager = new SessionManager(cwd);

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
    if (visible) {
      setQuery("");
      resetScroll();
      setConfirmClear(false);
      refresh();
    }
  }, [visible, resetScroll, refresh]);

  const filtered = (() => {
    const fq = query.toLowerCase().trim();
    return fq ? sessions.filter((s) => s.title.toLowerCase().includes(fq)) : sessions;
  })();

  const handleKeyboard = (evt: { name?: string; ctrl?: boolean; meta?: boolean }) => {
    if (!visible) return;

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
          refresh();
        }
        setRenameId(null);
        return;
      }
      if (evt.name === "backspace" || evt.name === "delete") {
        setRenameValue((prev) => prev.slice(0, -1));
        return;
      }
      if (evt.name === "space") {
        setRenameValue((prev) => `${prev} `);
        return;
      }
      if (evt.name && evt.name.length === 1 && !evt.ctrl && !evt.meta) {
        setRenameValue((prev) => prev + evt.name);
      }
      return;
    }

    if (confirmClear) {
      if (evt.name === "y") {
        const count = manager.clearAllSessions();
        onSystemMessage(`Cleared ${String(count)} session(s).`);
        setConfirmClear(false);
        refresh();
        resetScroll();
        return;
      }
      setConfirmClear(false);
      return;
    }

    if (evt.name === "escape") {
      onClose();
      return;
    }

    if (evt.name === "up") {
      setCursor((prev: number) => {
        const next = prev > 0 ? prev - 1 : Math.max(0, filtered.length - 1);
        adjustScroll(next);
        return next;
      });
      return;
    }
    if (evt.name === "down") {
      setCursor((prev: number) => {
        const next = prev < filtered.length - 1 ? prev + 1 : 0;
        adjustScroll(next);
        return next;
      });
      return;
    }

    if (evt.name === "return") {
      const session = filtered[cursor];
      if (session) {
        onRestore(session.id);
        onClose();
      }
      return;
    }

    if (evt.name === "backspace" || evt.name === "delete") {
      setQuery((prev) => prev.slice(0, -1));
      resetScroll();
      return;
    }

    if (evt.name === "d" && evt.ctrl) {
      const session = filtered[cursor];
      if (session) {
        manager.deleteSession(session.id);
        onSystemMessage(`Deleted session: ${session.title}`);
        refresh();
        setCursor((prev: number) => Math.min(prev, Math.max(0, filtered.length - 1)));
      }
      return;
    }

    if (evt.name === "r" && evt.ctrl) {
      const session = filtered[cursor];
      if (session) {
        setRenameId(session.id);
        setRenameValue(session.title);
      }
      return;
    }

    if (evt.name === "x" && evt.ctrl) {
      if (sessions.length > 0) setConfirmClear(true);
      return;
    }

    if (evt.name === "space") {
      setQuery((prev) => `${prev} `);
      resetScroll();
      return;
    }

    if (evt.name && evt.name.length === 1 && !evt.ctrl && !evt.meta) {
      setQuery((prev) => prev + evt.name);
      resetScroll();
    }
  };

  useKeyboard(handleKeyboard);

  // Build table content from visible sessions
  const visibleSessions = filtered.slice(scrollOffset, scrollOffset + maxVisible);
  // Reserve space for fixed columns with manual spacing: " Msgs"(5) + " Size"(5) + " Updated"(8) + prefix(2)
  const titleMaxW = Math.max(15, innerW - 22);
  const tableContent = useMemo((): TextTableContent => {
    // Header row — pad left on non-title columns for spacing
    const header = [
      [chunk("  Title", t.brandDim, TextAttributes.BOLD)],
      [chunk(" Msgs", t.brandDim, TextAttributes.BOLD)],
      [chunk(" Size", t.brandDim, TextAttributes.BOLD)],
      [chunk(" Updated", t.brandDim, TextAttributes.BOLD)],
    ];

    const rows: TextTableContent = [header];

    for (let vi = 0; vi < visibleSessions.length; vi++) {
      const session = visibleSessions[vi];
      if (!session) continue;
      const i = vi + scrollOffset;
      const isActive = i === cursor;

      const prefix = isActive ? "\u203A " : "  ";
      const maxTitle = titleMaxW - 2; // account for prefix
      // Strip newlines — session titles can contain them from multi-line first messages
      const cleanTitle = session.title.replace(/[\n\r]+/g, " ");
      const titleText =
        cleanTitle.length > maxTitle ? `${cleanTitle.slice(0, maxTitle - 1)}\u2026` : cleanTitle;

      rows.push([
        [
          chunk(prefix, isActive ? t.brand : t.textFaint),
          chunk(
            titleText,
            isActive ? t.textPrimary : t.textSecondary,
            isActive ? TextAttributes.BOLD : 0,
          ),
        ],
        [chunk(` ${String(session.messageCount)}`, isActive ? t.brandAlt : t.textMuted)],
        [chunk(` ${formatSize(session.sizeBytes)}`, isActive ? t.textMuted : t.textMuted)],
        [chunk(` ${timeAgo(session.updatedAt)}`, isActive ? t.textMuted : t.textDim)],
      ]);
    }

    return rows;
  }, [visibleSessions, scrollOffset, cursor, t, titleMaxW]);

  if (!visible) return null;

  const totalSize = sessions.reduce((s, x) => s + x.sizeBytes, 0);
  return (
    <Popup
      width={popupWidth}
      title="Sessions"
      icon={icon("clock_alt")}
      headerRight={
        <text fg={t.textMuted} bg={POPUP_BG}>
          {" "}
          {String(sessions.length)} sessions {"\u00B7"} {formatSize(totalSize)}
        </text>
      }
      footer={[
        { key: "\u2191\u2193", label: "navigate" },
        { key: "\u23CE", label: "restore" },
        { key: "^R", label: "rename" },
        { key: "^D", label: "delete" },
        { key: "^X", label: "clear all" },
        { key: "esc", label: "close" },
      ]}
    >
      {/* Search */}
      <PopupRow w={innerW}>
        <text fg={t.brand} bg={POPUP_BG}>
          {"\uD83D\uDD0D"}{" "}
        </text>
        <text fg={t.textPrimary} attributes={TextAttributes.BOLD} bg={POPUP_BG}>
          {query}
        </text>
        <text fg={t.brandAlt} bg={POPUP_BG}>
          {"\u258E"}
        </text>
        {!query ? (
          <text fg={t.textDim} bg={POPUP_BG}>
            {" type to search\u2026"}
          </text>
        ) : (
          <text fg={t.textMuted} bg={POPUP_BG}>
            {` ${String(filtered.length)} result${filtered.length === 1 ? "" : "s"}`}
          </text>
        )}
      </PopupRow>

      {/* Separator */}
      <PopupRow w={innerW}>
        <text fg={t.textSubtle} bg={POPUP_BG}>
          {"\u2500".repeat(innerW - 4)}
        </text>
      </PopupRow>

      {/* Session table */}
      {loading && sessions.length === 0 ? (
        <box
          flexDirection="column"
          height={Math.min(3, maxVisible)}
          justifyContent="center"
          alignItems="center"
        >
          <box flexDirection="row" gap={1} justifyContent="center">
            <Spinner color={t.brand} />
            <text fg={t.textMuted} bg={POPUP_BG}>
              Consulting the scrolls…
            </text>
          </box>
        </box>
      ) : filtered.length === 0 ? (
        <PopupRow w={innerW}>
          <text fg={t.textMuted} bg={POPUP_BG}>
            {"  "}
            {icon("clock_alt")}{" "}
            {query ? "no matching sessions" : "no sessions yet \u2014 start chatting!"}
          </text>
        </PopupRow>
      ) : (
        <text-table
          content={tableContent}
          width={innerW}
          border={false}
          outerBorder={false}
          showBorders={false}
          columnWidthMode="full"
          wrapMode="none"
          fg={t.textSecondary}
          bg={POPUP_BG}
          backgroundColor={POPUP_BG}
          cellPadding={0}
        />
      )}

      {/* Scroll indicator */}
      {filtered.length > maxVisible && (
        <PopupRow w={innerW}>
          <text fg={t.textMuted} bg={POPUP_BG}>
            {scrollOffset > 0 ? "\u2191 " : "  "}
            {String(cursor + 1)}/{String(filtered.length)}
            {scrollOffset + maxVisible < filtered.length ? " \u2193" : ""}
          </text>
        </PopupRow>
      )}

      {/* Confirm clear */}
      {confirmClear && (
        <PopupRow w={innerW} bg={t.error}>
          <text fg="#fff" attributes={TextAttributes.BOLD} bg={t.error}>
            Delete all {String(sessions.length)} sessions? (y/n)
          </text>
        </PopupRow>
      )}

      {renameId && (
        <PopupRow w={innerW}>
          <text fg={t.brand} bg={POPUP_BG}>
            {"Rename: "}
          </text>
          <text fg={t.textPrimary} attributes={TextAttributes.BOLD} bg={POPUP_BG}>
            {renameValue}
          </text>
          <text fg={t.brandAlt} bg={POPUP_BG}>
            {"\u258E"}
          </text>
        </PopupRow>
      )}
    </Popup>
  );
}
