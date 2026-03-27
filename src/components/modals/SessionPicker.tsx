import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { icon } from "../../core/icons.js";
import { type SessionListEntry, SessionManager } from "../../core/sessions/manager.js";
import { usePopupScroll } from "../../hooks/usePopupScroll.js";
import { timeAgo } from "../../utils/time.js";
import { Overlay, POPUP_BG, POPUP_HL, PopupRow } from "../layout/shared.js";

const POPUP_CHROME = 8;
const ROW_ALT = "#131328";
const COL_MSGS = 7;
const COL_SIZE = 7;
const COL_TIME = 11;
const COL_FIXED = COL_MSGS + COL_SIZE + COL_TIME + 6;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)}K`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)}M`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)}G`;
}

function rpad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
}

function lpad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : " ".repeat(w - s.length) + s;
}

interface Props {
  visible: boolean;
  cwd: string;
  onClose: () => void;
  onRestore: (sessionId: string) => void;
  onSystemMessage: (msg: string) => void;
}

export function SessionPicker({ visible, cwd, onClose, onRestore, onSystemMessage }: Props) {
  const [sessions, setSessions] = useState<SessionListEntry[]>([]);
  const [query, setQuery] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const { width: termCols, height: termRows } = useTerminalDimensions();

  const containerRows = termRows - 2;
  const popupWidth = Math.min(90, Math.floor(termCols * 0.85));
  const maxVisible = Math.max(3, Math.floor(containerRows * 0.8) - POPUP_CHROME);
  const innerW = popupWidth - 2;
  const titleColW = Math.max(15, innerW - COL_FIXED - 4);
  const { cursor, setCursor, scrollOffset, adjustScroll, resetScroll } = usePopupScroll(maxVisible);

  const manager = useMemo(() => new SessionManager(cwd), [cwd]);

  const refresh = useCallback(() => {
    setSessions(manager.listSessions());
  }, [manager]);

  useEffect(() => {
    if (visible) {
      setQuery("");
      resetScroll();
      setConfirmClear(false);
      refresh();
    }
  }, [visible, refresh, resetScroll]);

  const filterQuery = query.toLowerCase().trim();
  const filtered = filterQuery
    ? sessions.filter((s) => s.title.toLowerCase().includes(filterQuery))
    : sessions;

  useKeyboard((evt) => {
    if (!visible) return;

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
      setCursor((prev) => {
        const next = prev > 0 ? prev - 1 : Math.max(0, filtered.length - 1);
        adjustScroll(next);
        return next;
      });
      return;
    }
    if (evt.name === "down") {
      setCursor((prev) => {
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
        setCursor((prev) => Math.min(prev, Math.max(0, filtered.length - 1)));
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
  });

  if (!visible) return null;

  const totalSize = sessions.reduce((s, x) => s + x.sizeBytes, 0);

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
          <text fg="#9B30FF" bg={POPUP_BG}>
            {icon("clock_alt")}{" "}
          </text>
          <text fg="white" attributes={TextAttributes.BOLD} bg={POPUP_BG}>
            Sessions
          </text>
          <text fg="#555" bg={POPUP_BG}>
            {" "}
            {String(sessions.length)} sessions · {formatSize(totalSize)}
          </text>
        </PopupRow>

        {/* Search */}
        <PopupRow w={innerW}>
          <text fg="#8B5CF6" bg={POPUP_BG}>
            {icon("search")} {"> "}
          </text>
          <text fg="white" bg={POPUP_BG}>
            {query}
          </text>
          <text fg="#8B5CF6" bg={POPUP_BG}>
            ▎
          </text>
          {!query && (
            <text fg="#444" bg={POPUP_BG}>
              {" type to search…"}
            </text>
          )}
        </PopupRow>

        {/* Column headers */}
        <PopupRow w={innerW}>
          <text fg="#555" bg={POPUP_BG} attributes={TextAttributes.BOLD}>
            {"  "}
            {rpad("Title", titleColW)}
            {lpad("Msgs", COL_MSGS)}
            {lpad("Size", COL_SIZE)}
            {lpad("Updated", COL_TIME)}
          </text>
        </PopupRow>

        {/* Separator */}
        <PopupRow w={innerW}>
          <text fg="#222" bg={POPUP_BG}>
            {"─".repeat(innerW - 4)}
          </text>
        </PopupRow>

        {/* List */}
        <box
          flexDirection="column"
          height={Math.min(filtered.length || 1, maxVisible)}
          overflow="hidden"
        >
          {filtered.length === 0 ? (
            <PopupRow w={innerW}>
              <text fg="#555" bg={POPUP_BG}>
                {"  "}
                {icon("clock_alt")}{" "}
                {query ? "no matching sessions" : "no sessions yet — start chatting!"}
              </text>
            </PopupRow>
          ) : (
            filtered.slice(scrollOffset, scrollOffset + maxVisible).map((session, vi) => {
              const i = vi + scrollOffset;
              const isActive = i === cursor;
              const isOdd = i % 2 === 1;
              const bg = isActive ? POPUP_HL : isOdd ? ROW_ALT : POPUP_BG;
              const title =
                session.title.length > titleColW - 2
                  ? `${session.title.slice(0, titleColW - 4)}…`
                  : session.title;

              return (
                <PopupRow key={session.id} bg={bg} w={innerW}>
                  <text bg={bg} fg={isActive ? "#9B30FF" : "#333"}>
                    {isActive ? "› " : "  "}
                  </text>
                  <text
                    bg={bg}
                    fg={isActive ? "#ccc" : "#999"}
                    attributes={isActive ? TextAttributes.BOLD : undefined}
                  >
                    {rpad(title, titleColW)}
                  </text>
                  <text bg={bg} fg={isActive ? "#8B5CF6" : "#666"}>
                    {lpad(String(session.messageCount), COL_MSGS)}
                  </text>
                  <text bg={bg} fg={isActive ? "#666" : "#555"}>
                    {lpad(formatSize(session.sizeBytes), COL_SIZE)}
                  </text>
                  <text bg={bg} fg={isActive ? "#666" : "#444"}>
                    {lpad(timeAgo(session.updatedAt), COL_TIME)}
                  </text>
                </PopupRow>
              );
            })
          )}
        </box>

        {/* Scroll */}
        {filtered.length > maxVisible && (
          <PopupRow w={innerW}>
            <text fg="#555" bg={POPUP_BG}>
              {scrollOffset > 0 ? "↑ " : "  "}
              {String(cursor + 1)}/{String(filtered.length)}
              {scrollOffset + maxVisible < filtered.length ? " ↓" : ""}
            </text>
          </PopupRow>
        )}

        {/* Confirm clear */}
        {confirmClear && (
          <PopupRow w={innerW}>
            <text fg="#FF0040" attributes={TextAttributes.BOLD} bg={POPUP_BG}>
              Delete all {String(sessions.length)} sessions? (y/n)
            </text>
          </PopupRow>
        )}

        <PopupRow w={innerW}>
          <text>{""}</text>
        </PopupRow>

        {/* Footer */}
        <PopupRow w={innerW}>
          <text fg="#444" bg={POPUP_BG}>
            ↑↓ navigate | ⏎ restore | ^D delete | ^X clear all | esc close
          </text>
        </PopupRow>
      </box>
    </Overlay>
  );
}
