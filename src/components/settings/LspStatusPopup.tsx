import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getDetailedLspServers, getNvimLspClients } from "../../core/intelligence/instance.js";
import { type ThemeTokens, useTheme } from "../../core/theme/index.js";
import { useErrorStore } from "../../stores/errors.js";
import {
  buildGroupedRows,
  type GroupedItem,
  GroupedList,
  type GroupedListGroup,
  handleCursorNavKey,
  InfoLine,
  type InfoLineData,
  PremiumPopup,
  Section,
} from "../ui/index.js";

const POLL_MS = 2000;

interface LspServerDetail {
  language: string;
  command: string;
  args: string[];
  pid: number | null;
  cwd: string;
  openFiles: number;
  diagnosticCount: number;
  diagnostics: Array<{ file: string; message: string; severity: number }>;
  ready: boolean;
  backend: "standalone" | "neovim";
}

interface NvimClient {
  name: string;
  language: string;
  pid: number | null;
}

function severityLabel(severity: number, t: ThemeTokens): { text: string; color: string } {
  switch (severity) {
    case 1:
      return { text: "ERR", color: t.error };
    case 2:
      return { text: "WRN", color: t.warning };
    case 3:
      return { text: "INF", color: t.info };
    case 4:
      return { text: "HNT", color: t.textMuted };
    default:
      return { text: "ERR", color: t.error };
  }
}

function shortCommand(cmd: string): string {
  return cmd.split("/").pop() ?? cmd;
}

function shortPath(path: string, maxLen: number): string {
  if (path.length <= maxLen) return path;
  const home = process.env.HOME ?? "";
  if (home && path.startsWith(home)) {
    const rel = `~${path.slice(home.length)}`;
    if (rel.length <= maxLen) return rel;
    return `…${rel.slice(-(maxLen - 1))}`;
  }
  return `…${path.slice(-(maxLen - 1))}`;
}

interface ServerRow extends GroupedItem {
  detail: LspServerDetail | null;
  nvim: NvimClient | null;
}

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function LspStatusPopup({ visible, onClose }: Props) {
  const t = useTheme();
  const { width: tw, height: th } = useTerminalDimensions();
  const [cursor, setCursor] = useState(0);
  const [detailIdx, setDetailIdx] = useState<number | null>(null);
  const [servers, setServers] = useState<LspServerDetail[]>([]);
  const [nvimClients, setNvimClients] = useState<NvimClient[]>([]);
  const detailScrollRef = useRef<ScrollBoxRenderable>(null);
  const detailOffset = useRef(0);

  const bgErrors = useErrorStore((s) => s.errors);
  const lspErrors = useMemo(() => bgErrors.filter((e) => e.source.startsWith("LSP:")), [bgErrors]);

  const popupW = Math.min(110, Math.max(72, Math.floor(tw * 0.8)));
  const popupH = Math.min(30, Math.max(16, th - 4));
  const contentW = popupW - 4;

  useEffect(() => {
    if (!visible) return;
    setCursor(0);
    setDetailIdx(null);
    detailOffset.current = 0;

    const poll = async () => {
      const sd: LspServerDetail[] = (await getDetailedLspServers()).map((s) => ({
        ...s,
        backend: "standalone" as const,
      }));
      setServers(sd);
      getNvimLspClients()
        .then((clients) => setNvimClients(clients ?? []))
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [visible]);

  const groups = useMemo<GroupedListGroup<ServerRow>[]>(() => {
    const items: ServerRow[] = [];
    for (const s of servers) {
      items.push({
        id: `s-${s.language}-${s.pid ?? ""}`,
        detail: s,
        nvim: null,
        label: shortCommand(s.command),
        meta: `${s.language} · ${s.backend}${s.diagnosticCount > 0 ? ` · ${s.diagnosticCount} diag` : ""}`,
        status: s.ready ? "online" : "warning",
      });
    }
    for (const n of nvimClients) {
      items.push({
        id: `n-${n.name}-${n.pid ?? ""}`,
        detail: null,
        nvim: n,
        label: n.name,
        meta: `${n.language} · neovim${n.pid ? ` · pid:${n.pid}` : ""}`,
        status: "online",
      });
    }
    return [{ id: "lsp", label: "Servers", hideHeader: true, items }];
  }, [servers, nvimClients]);

  const rows = useMemo(() => buildGroupedRows(groups, new Set(["lsp"])), [groups]);

  const inDetail = detailIdx !== null;
  const selectedRow = inDetail ? (rows[detailIdx]?.item as ServerRow | undefined) : undefined;
  const selectedServer = selectedRow?.detail ?? null;

  const detailLines = useMemo<InfoLineData[]>(() => {
    if (!selectedServer) return [];
    const lines: InfoLineData[] = [
      { type: "header", label: "Server" },
      { type: "entry", label: "Command", desc: selectedServer.command },
    ];
    if (selectedServer.args.length > 0) {
      lines.push({ type: "entry", label: "Args", desc: selectedServer.args.join(" ") });
    }
    lines.push(
      { type: "entry", label: "PID", desc: String(selectedServer.pid ?? "N/A") },
      { type: "entry", label: "Status", desc: selectedServer.ready ? "Running" : "Starting" },
      { type: "spacer" },
      { type: "header", label: "Workspace" },
      { type: "entry", label: "Root", desc: selectedServer.cwd },
      { type: "entry", label: "Open files", desc: String(selectedServer.openFiles) },
      { type: "spacer" },
      { type: "header", label: "Diagnostics" },
    );
    if (selectedServer.diagnostics.length === 0) {
      lines.push({ type: "text", label: "  No diagnostics", color: t.textMuted });
    } else {
      for (const d of selectedServer.diagnostics) {
        const sev = severityLabel(d.severity, t);
        lines.push({
          type: "text",
          label: `  [${sev.text}] ${shortPath(d.file, 30)}: ${d.message}`,
          color: sev.color,
        });
      }
    }
    const serverErrors = lspErrors.filter((e) =>
      e.source.includes(shortCommand(selectedServer.command)),
    );
    if (serverErrors.length > 0) {
      lines.push({ type: "spacer" }, { type: "header", label: "Recent Errors" });
      for (const e of serverErrors.slice(0, 10)) {
        lines.push({ type: "text", label: `  ${e.message}`, color: t.error });
      }
    }
    return lines;
  }, [selectedServer, lspErrors, t]);

  const detailRows = Math.max(6, popupH - 9);

  useKeyboard((evt) => {
    if (!visible) return;

    if (inDetail) {
      if (evt.name === "escape") {
        setDetailIdx(null);
        detailOffset.current = 0;
        return;
      }
      if (evt.name === "up" || evt.name === "k") {
        const n = Math.max(0, detailOffset.current - 1);
        detailOffset.current = n;
        detailScrollRef.current?.scrollTo(n);
        return;
      }
      if (evt.name === "down" || evt.name === "j") {
        const maxOff = Math.max(0, detailLines.length - detailRows);
        const n = Math.min(maxOff, detailOffset.current + 1);
        detailOffset.current = n;
        detailScrollRef.current?.scrollTo(n);
        return;
      }
      return;
    }

    if (evt.name === "escape") {
      onClose();
      return;
    }
    if (evt.name === "return") {
      const r = rows[cursor];
      if (r?.kind === "item" && (r.item as ServerRow).detail) {
        setDetailIdx(cursor);
      }
      return;
    }
    handleCursorNavKey(evt, setCursor, rows.length);
  });

  if (!visible) return null;

  if (inDetail && selectedServer) {
    return (
      <PremiumPopup
        visible={visible}
        width={popupW}
        height={popupH}
        title={shortCommand(selectedServer.command)}
        titleIcon="code"
        blurb={`${selectedServer.language} · ${selectedServer.ready ? "running" : "starting"} · pid ${selectedServer.pid ?? "n/a"}`}
        status={selectedServer.ready ? "online" : "warning"}
        footerHints={[
          { key: "↑↓", label: "scroll" },
          { key: "Esc", label: "back" },
        ]}
      >
        <Section>
          <scrollbox ref={detailScrollRef} height={detailRows}>
            {detailLines.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: positional
              <InfoLine key={`d-${i}`} line={line} width={contentW} />
            ))}
          </scrollbox>
        </Section>
      </PremiumPopup>
    );
  }

  const blurb = `${servers.length} standalone${nvimClients.length > 0 ? ` · ${nvimClients.length} neovim` : ""}${lspErrors.length > 0 ? ` · ${lspErrors.length} errors` : ""}`;

  return (
    <PremiumPopup
      visible={visible}
      width={popupW}
      height={popupH}
      title="Language Servers"
      titleIcon="code"
      blurb={blurb}
      footerHints={[
        { key: "↑↓", label: "nav" },
        { key: "Enter", label: "detail" },
        { key: "Esc", label: "close" },
      ]}
    >
      <Section>
        {rows.length === 0 ? (
          <box flexDirection="row" paddingX={2} paddingY={1}>
            <text bg={t.bgPopup} fg={t.textMuted}>
              · No language servers running
            </text>
          </box>
        ) : (
          <GroupedList
            groups={groups}
            expanded={new Set(["lsp"])}
            selectedIndex={cursor}
            width={contentW}
            maxRows={Math.max(4, popupH - 9)}
          />
        )}
      </Section>
    </PremiumPopup>
  );
}
