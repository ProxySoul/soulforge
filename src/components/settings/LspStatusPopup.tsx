import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useState } from "react";
import { getDetailedLspServers, getNvimLspClients } from "../../core/intelligence/instance.js";
import { useErrorStore } from "../../stores/errors.js";
import { Overlay, POPUP_BG, POPUP_HL, PopupRow } from "../layout/shared.js";

const CHROME_ROWS = 7;
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

const SEVERITY_LABEL: Record<number, { text: string; color: string }> = {
  1: { text: "ERR", color: "#FF0040" },
  2: { text: "WRN", color: "#FF8C00" },
  3: { text: "INF", color: "#5af" },
  4: { text: "HNT", color: "#555" },
};

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

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function LspStatusPopup({ visible, onClose }: Props) {
  const [cursor, setCursor] = useState(0);
  const [detailIdx, setDetailIdx] = useState<number | null>(null);
  const [detailScroll, setDetailScroll] = useState(0);
  const [servers, setServers] = useState<LspServerDetail[]>([]);
  const { width: termCols, height: termRows } = useTerminalDimensions();
  const popupWidth = Math.max(60, Math.round(termCols * 0.8));
  const innerW = popupWidth - 2;
  const popupHeight = Math.max(12, Math.round(termRows * 0.7));
  const maxListVisible = Math.max(4, popupHeight - CHROME_ROWS);

  const bgErrors = useErrorStore((s) => s.errors);
  const lspErrors = useMemo(() => bgErrors.filter((e) => e.source.startsWith("LSP:")), [bgErrors]);

  const [nvimClients, setNvimClients] = useState<NvimClient[]>([]);

  useEffect(() => {
    if (!visible) return;
    setCursor(0);
    setDetailIdx(null);
    setDetailScroll(0);
    const poll = () => {
      const standalone: LspServerDetail[] = getDetailedLspServers().map((s) => ({
        ...s,
        backend: "standalone",
      }));
      setServers(standalone);
      getNvimLspClients()
        .then((clients) => setNvimClients(clients ?? []))
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [visible]);

  const inDetail = detailIdx !== null;
  const selectedServer = inDetail ? servers[detailIdx] : null;

  const detailLines = useMemo(() => {
    if (!selectedServer) return [];
    const lines: string[] = [];

    lines.push("── Server ──");
    lines.push(`Command:  ${selectedServer.command}`);
    if (selectedServer.args.length > 0) lines.push(`Args:     ${selectedServer.args.join(" ")}`);
    lines.push(`PID:      ${selectedServer.pid ?? "N/A"}`);
    lines.push(`Status:   ${selectedServer.ready ? "Running" : "Starting"}`);
    lines.push("");

    lines.push("── Workspace ──");
    lines.push(`Root:     ${selectedServer.cwd}`);
    lines.push(`Files:    ${String(selectedServer.openFiles)} open`);
    lines.push("");

    lines.push("── Diagnostics ──");
    if (selectedServer.diagnostics.length === 0) {
      lines.push("  No diagnostics");
    } else {
      for (const d of selectedServer.diagnostics) {
        const sev = SEVERITY_LABEL[d.severity] ?? { text: "ERR", color: "#FF0040" };
        const file = shortPath(d.file, 30);
        lines.push(`  [${sev.text}] ${file}: ${d.message}`);
      }
    }
    lines.push("");

    const serverErrors = lspErrors.filter((e) =>
      e.source.includes(shortCommand(selectedServer.command)),
    );
    if (serverErrors.length > 0) {
      lines.push("── Recent Errors ──");
      for (const e of serverErrors.slice(0, 10)) {
        lines.push(`  ${e.message}`);
      }
    }

    return lines;
  }, [selectedServer, lspErrors]);

  const maxDetailLines = Math.max(4, popupHeight - 6);

  useKeyboard((evt) => {
    if (!visible) return;

    if (inDetail) {
      if (evt.name === "escape") {
        setDetailIdx(null);
        setDetailScroll(0);
        return;
      }
      if (evt.name === "up") {
        setDetailScroll((p) => Math.max(0, p - 1));
        return;
      }
      if (evt.name === "down") {
        setDetailScroll((p) => Math.min(Math.max(0, detailLines.length - maxDetailLines), p + 1));
        return;
      }
      return;
    }

    if (evt.name === "escape") {
      onClose();
      return;
    }
    if (evt.name === "up") {
      setCursor((p) => (p > 0 ? p - 1 : Math.max(0, servers.length - 1)));
      return;
    }
    if (evt.name === "down") {
      setCursor((p) => (p < servers.length - 1 ? p + 1 : 0));
      return;
    }
    if (evt.name === "return") {
      if (servers[cursor]) setDetailIdx(cursor);
      return;
    }
  });

  if (!visible) return null;

  if (inDetail && selectedServer) {
    const statusColor = selectedServer.ready ? "#2d5" : "#FF8C00";
    const statusIcon = selectedServer.ready ? "\u25CF" : "\u25CB";

    return (
      <Overlay>
        <box
          flexDirection="column"
          borderStyle="rounded"
          border={true}
          borderColor="#8B5CF6"
          width={popupWidth}
        >
          <PopupRow w={innerW}>
            <text fg={statusColor} bg={POPUP_BG}>
              {statusIcon}
            </text>
            <text fg="white" attributes={TextAttributes.BOLD} bg={POPUP_BG}>
              {" "}
              {shortCommand(selectedServer.command)}
            </text>
            <text fg="#555" bg={POPUP_BG}>
              {"  "}
              {selectedServer.language}
            </text>
          </PopupRow>

          <PopupRow w={innerW}>
            <text fg="#333" bg={POPUP_BG}>
              {"\u2500".repeat(innerW - 4)}
            </text>
          </PopupRow>

          <box
            flexDirection="column"
            height={Math.min(detailLines.length, maxDetailLines)}
            overflow="hidden"
          >
            {detailLines.slice(detailScroll, detailScroll + maxDetailLines).map((line, vi) => {
              const isSection = line.startsWith("\u2500\u2500");
              const isError = line.includes("[ERR]");
              const isWarn = line.includes("[WRN]");
              const fg = isSection ? "#8B5CF6" : isError ? "#FF0040" : isWarn ? "#FF8C00" : "#aaa";
              return (
                <PopupRow key={String(vi + detailScroll)} w={innerW}>
                  <text
                    fg={fg}
                    attributes={isSection ? TextAttributes.BOLD : undefined}
                    bg={POPUP_BG}
                    truncate
                  >
                    {line.length > innerW - 4 ? `${line.slice(0, innerW - 5)}\u2026` : line || " "}
                  </text>
                </PopupRow>
              );
            })}
          </box>
          {detailLines.length > maxDetailLines && (
            <PopupRow w={innerW}>
              <text fg="#555" bg={POPUP_BG}>
                {detailScroll > 0 ? "\u2191 " : "  "}
                {String(detailScroll + 1)}-
                {String(Math.min(detailScroll + maxDetailLines, detailLines.length))}/
                {String(detailLines.length)}
                {detailScroll + maxDetailLines < detailLines.length ? " \u2193" : ""}
              </text>
            </PopupRow>
          )}

          <PopupRow w={innerW}>
            <text>{""}</text>
          </PopupRow>

          <PopupRow w={innerW}>
            <text fg="#555" bg={POPUP_BG}>
              {"\u2191\u2193"} scroll | esc back
            </text>
          </PopupRow>
        </box>
      </Overlay>
    );
  }

  return (
    <Overlay>
      <box
        flexDirection="column"
        borderStyle="rounded"
        border={true}
        borderColor="#8B5CF6"
        width={popupWidth}
      >
        <PopupRow w={innerW}>
          <text fg="#9B30FF" attributes={TextAttributes.BOLD} bg={POPUP_BG}>
            {"\uDB81\uDCA4"}
          </text>
          <text fg="white" attributes={TextAttributes.BOLD} bg={POPUP_BG}>
            {" "}
            Language Servers
          </text>
          <text fg="#555" bg={POPUP_BG}>
            {" "}
            ({String(servers.length)} standalone
            {nvimClients.length > 0 ? ` + ${String(nvimClients.length)} neovim` : ""})
          </text>
        </PopupRow>

        <PopupRow w={innerW}>
          <text fg="#333" bg={POPUP_BG}>
            {"\u2500".repeat(innerW - 4)}
          </text>
        </PopupRow>

        <box
          flexDirection="column"
          height={Math.min(servers.length + nvimClients.length || 1, maxListVisible)}
          overflow="hidden"
        >
          {servers.length === 0 && nvimClients.length === 0 ? (
            <PopupRow w={innerW}>
              <text fg="#555" bg={POPUP_BG}>
                No language servers running
              </text>
            </PopupRow>
          ) : (
            <>
              {servers.slice(0, maxListVisible).map((srv, i) => {
                const isActive = i === cursor;
                const bg = isActive ? POPUP_HL : POPUP_BG;
                const statusColor = srv.ready ? "#2d5" : "#FF8C00";
                const statusIcon = srv.ready ? "\u25CF" : "\u25CB";
                const cmd = shortCommand(srv.command);
                const diagLabel =
                  srv.diagnosticCount > 0 ? ` ${String(srv.diagnosticCount)} diag` : "";
                const diagColor = srv.diagnosticCount > 0 ? "#FF8C00" : "#555";

                return (
                  <PopupRow key={`s-${srv.language}-${String(srv.pid)}`} bg={bg} w={innerW}>
                    <text bg={bg} fg={isActive ? "#FF0040" : "#555"}>
                      {isActive ? "\u203A " : "  "}
                    </text>
                    <text bg={bg} fg={statusColor}>
                      {statusIcon}{" "}
                    </text>
                    <text
                      bg={bg}
                      fg={isActive ? "white" : "#aaa"}
                      attributes={isActive ? TextAttributes.BOLD : undefined}
                    >
                      {cmd}
                    </text>
                    <text bg={bg} fg="#666">
                      {"  "}
                      {srv.language}
                    </text>
                    <text bg={bg} fg="#2dd4bf">
                      {" [standalone]"}
                    </text>
                    <text bg={bg} fg={diagColor}>
                      {diagLabel}
                    </text>
                  </PopupRow>
                );
              })}
              {nvimClients.map((nc) => (
                <PopupRow key={`n-${nc.name}-${String(nc.pid)}`} w={innerW}>
                  <text fg="#555">{"  "}</text>
                  <text fg="#57A143">{"\u25CF "}</text>
                  <text fg="#aaa">{nc.name}</text>
                  <text fg="#666">
                    {"  "}
                    {nc.language}
                  </text>
                  <text fg="#57A143">{" [neovim]"}</text>
                  {nc.pid ? (
                    <text fg="#444">
                      {"  pid:"}
                      {String(nc.pid)}
                    </text>
                  ) : null}
                </PopupRow>
              ))}
            </>
          )}
        </box>

        {lspErrors.length > 0 && (
          <>
            <PopupRow w={innerW}>
              <text fg="#333" bg={POPUP_BG}>
                {"\u2500".repeat(innerW - 4)}
              </text>
            </PopupRow>
            <PopupRow w={innerW}>
              <text fg="#FF0040" bg={POPUP_BG}>
                {String(lspErrors.length)} background error{lspErrors.length === 1 ? "" : "s"}
              </text>
            </PopupRow>
          </>
        )}

        <PopupRow w={innerW}>
          <text>{""}</text>
        </PopupRow>

        <PopupRow w={innerW}>
          <text fg="#555" bg={POPUP_BG}>
            {"\u2191\u2193"} nav | {"\u23CE"} details | esc close
          </text>
        </PopupRow>
      </box>
    </Overlay>
  );
}
