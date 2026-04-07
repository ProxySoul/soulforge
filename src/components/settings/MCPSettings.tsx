import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { icon } from "../../core/icons.js";
import type { MCPManager } from "../../core/mcp/manager.js";
import { useTheme } from "../../core/theme/index.js";
import { usePopupScroll } from "../../hooks/usePopupScroll.js";
import { type MCPServerState, type MCPServerStatus, useMCPStore } from "../../stores/mcp.js";
import type { MCPServerConfig } from "../../types/index.js";
import type { ConfigScope } from "../layout/shared.js";
import { Overlay, POPUP_BG, POPUP_HL, PopupRow, Spinner } from "../layout/shared.js";

// ─── Helpers ──────────────────────────────────────────────

function statusIcon(s: MCPServerStatus): string {
  if (s === "ready") return icon("success");
  if (s === "error") return icon("error");
  if (s === "disabled") return icon("ban");
  if (s === "connecting") return icon("spinner");
  return icon("circle_empty");
}

function statusColor(s: MCPServerStatus, t: ReturnType<typeof useTheme>): string {
  if (s === "ready") return t.success;
  if (s === "connecting") return t.warning;
  if (s === "error") return t.error;
  if (s === "disabled") return t.textDim;
  return t.textMuted;
}

const STATUS_LABEL: Record<MCPServerStatus, string> = {
  disconnected: "offline",
  connecting: "connecting…",
  ready: "connected",
  error: "error",
  disabled: "disabled",
};

function uptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 > 0 ? `${m % 60}m` : ""}`;
}

// ─── Draft ────────────────────────────────────────────────

interface Draft {
  name: string;
  transport: "stdio" | "http" | "sse";
  command: string;
  url: string;
  args: string;
  env: string;
  headers: string;
  scope: ConfigScope;
}

const TRANSPORTS: Draft["transport"][] = ["stdio", "http", "sse"];
const TRANSPORT_LABEL: Record<Draft["transport"], string> = {
  stdio: "stdio",
  http: "http",
  sse: "sse (legacy)",
};

const EMPTY: Draft = {
  name: "",
  transport: "stdio",
  command: "",
  url: "",
  args: "",
  env: "",
  headers: "",
  scope: "project",
};

type Field = "name" | "command" | "url" | "args" | "env" | "headers";

function fieldsFor(t: Draft["transport"]): Field[] {
  if (t === "stdio") return ["name", "command", "args", "env"];
  return ["name", "url", "headers", "env"];
}

const LABEL: Record<Field, string> = {
  name: "Name",
  command: "Command",
  url: "URL",
  args: "Arguments",
  env: "Environment",
  headers: "Headers",
};
const HINT: Record<Field, string> = {
  name: "unique id (e.g. github, postgres)",
  command: "executable (e.g. npx, uvx, docker)",
  url: "https://mcp.example.com/mcp",
  args: "space-separated (e.g. -y @modelcontextprotocol/server-github)",
  env: "KEY=VAL, KEY2=VAL2",
  headers: "Authorization=Bearer xxx, X-Custom=val",
};

function parsePairs(input: string): Record<string, string> | undefined {
  if (!input.trim()) return undefined;
  try {
    return JSON.parse(input);
  } catch {
    const pairs: Record<string, string> = {};
    for (const line of input.split(",")) {
      const eq = line.indexOf("=");
      if (eq > 0) pairs[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    return Object.keys(pairs).length ? pairs : undefined;
  }
}

function draftToConfig(d: Draft): MCPServerConfig {
  const c: MCPServerConfig = { name: d.name.trim() };
  if (d.transport !== "stdio") {
    c.transport = d.transport;
    c.url = d.url.trim();
  } else {
    c.command = d.command.trim();
    if (d.args.trim()) c.args = d.args.split(/\s+/).filter(Boolean);
  }
  c.env = parsePairs(d.env);
  c.headers = parsePairs(d.headers);
  return c;
}

function pairsToString(p?: Record<string, string>): string {
  return p
    ? Object.entries(p)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")
    : "";
}

function configToDraft(c: MCPServerConfig, scope: ConfigScope): Draft {
  return {
    name: c.name,
    transport: c.transport ?? "stdio",
    command: c.command ?? "",
    url: c.url ?? "",
    args: (c.args ?? []).join(" "),
    env: pairsToString(c.env),
    headers: pairsToString(c.headers),
    scope,
  };
}

// ─── Props ────────────────────────────────────────────────

interface Props {
  visible: boolean;
  mcpManager: MCPManager | null;
  globalServers: MCPServerConfig[];
  projectServers: MCPServerConfig[];
  onSave: (servers: MCPServerConfig[], scope: ConfigScope) => void;
  onClose: () => void;
}

const MAX_WIDTH = 96;
const CHROME_ROWS = 8;

type View = "list" | "tools" | "form" | "detail";

// ─── Main ─────────────────────────────────────────────────

export function MCPSettings({
  visible,
  mcpManager,
  globalServers,
  projectServers,
  onSave,
  onClose,
}: Props) {
  const t = useTheme();
  const { width: termCols, height: termRows } = useTerminalDimensions();
  const popupWidth = Math.min(MAX_WIDTH, Math.floor(termCols * 0.9));
  const innerW = popupWidth - 2;
  const containerRows = Math.floor((termRows - 2) * 0.8);
  const maxVisibleRows = Math.max(6, containerRows - CHROME_ROWS);
  const serverPageSize = Math.max(2, Math.floor(maxVisibleRows / 3));
  const toolPageSize = Math.max(3, Math.floor(maxVisibleRows / 2));

  const projectSet = useMemo(() => new Set(projectServers.map((s) => s.name)), [projectServers]);
  const scopeOf = useCallback(
    (n: string): ConfigScope => (projectSet.has(n) ? "project" : "global"),
    [projectSet],
  );

  const runtimeServers = useMCPStore((s) => s.servers);
  const serverList = useMemo(() => Object.values(runtimeServers), [runtimeServers]);
  const allTools = useMemo(
    () => serverList.flatMap((s) => s.tools.map((ti) => ({ ...ti, serverStatus: s.status }))),
    [serverList],
  );
  const readyCount = serverList.filter((s) => s.status === "ready").length;

  const [view, setView] = useState<View>("list");
  const [toolFilter, setToolFilter] = useState("");
  const [serverFilter, setServerFilter] = useState("");
  const [draft, setDraft] = useState<Draft>({ ...EMPTY });
  const [activeField, setActiveField] = useState<Field>("name");
  const [editingName, setEditingName] = useState<string | null>(null);
  const [detailName, setDetailName] = useState<string | null>(null);
  const [errorExpanded, setErrorExpanded] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleteChoice, setDeleteChoice] = useState<"no" | "yes">("no");

  const filteredTools = useMemo(() => {
    if (!toolFilter) return allTools;
    const q = toolFilter.toLowerCase();
    return allTools.filter(
      (ti) =>
        ti.name.toLowerCase().includes(q) ||
        ti.description.toLowerCase().includes(q) ||
        ti.serverName.toLowerCase().includes(q),
    );
  }, [allTools, toolFilter]);

  const filteredServers = useMemo(() => {
    if (!serverFilter) return serverList;
    const q = serverFilter.toLowerCase();
    return serverList.filter(
      (s) =>
        s.config.name.toLowerCase().includes(q) ||
        (s.config.command ?? "").toLowerCase().includes(q) ||
        (s.config.url ?? "").toLowerCase().includes(q) ||
        s.status.includes(q),
    );
  }, [serverList, serverFilter]);

  const pageSize = view === "list" ? serverPageSize : toolPageSize;
  const listCount =
    view === "list" ? filteredServers.length : view === "tools" ? filteredTools.length : 0;
  const { cursor, setCursor, scrollOffset, adjustScroll, resetScroll } = usePopupScroll(
    pageSize,
    listCount,
  );

  useEffect(() => {
    resetScroll();
  }, [resetScroll]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: serverFilter and toolFilter are intentional triggers — reset cursor when filter text changes
  useEffect(() => {
    resetScroll();
  }, [serverFilter, toolFilter, resetScroll]);
  useEffect(() => {
    if (visible) {
      setView("list");
      setToolFilter("");
      setServerFilter("");
      setDraft({ ...EMPTY });
      setActiveField("name");
      setEditingName(null);
      setDetailName(null);
      setErrorExpanded(false);
      setPendingDelete(null);
      setDeleteChoice("no");
      resetScroll();
    }
  }, [visible, resetScroll]);

  // ── Save helpers ──

  // All actions just save config. The useEffect in App.tsx watches effectiveConfig.mcpServers
  // and calls connectAll — the single entry point for all connection lifecycle.

  const openAdd = useCallback(() => {
    setDraft({ ...EMPTY });
    setActiveField("name");
    setEditingName(null);
    setView("form");
  }, []);

  const openEdit = useCallback(
    (name: string) => {
      const scope = scopeOf(name);
      const list = scope === "project" ? projectServers : globalServers;
      const cfg = list.find((s) => s.name === name);
      if (!cfg) return;
      setDraft(configToDraft(cfg, scope));
      setActiveField("name");
      setEditingName(name);
      setView("form");
    },
    [scopeOf, projectServers, globalServers],
  );

  const commitForm = useCallback(() => {
    if (!draft.name.trim()) return;
    const cfg = draftToConfig(draft);
    const scope = draft.scope;
    const list = scope === "project" ? projectServers : globalServers;
    const updated = editingName
      ? list.map((s) => (s.name === editingName ? cfg : s))
      : [...list, cfg];
    onSave(updated, scope);
    setView("list");
  }, [draft, editingName, projectServers, globalServers, onSave]);

  const deleteServer = useCallback(
    (name: string) => {
      const scope = scopeOf(name);
      const list = scope === "project" ? projectServers : globalServers;
      onSave(
        list.filter((s) => s.name !== name),
        scope,
      );
      setCursor((c) => Math.max(0, Math.min(c, filteredServers.length - 2)));
    },
    [scopeOf, projectServers, globalServers, onSave, setCursor, filteredServers.length],
  );

  const toggleDisabled = useCallback(
    (name: string) => {
      const scope = scopeOf(name);
      const list = scope === "project" ? projectServers : globalServers;
      const srv = list.find((s) => s.name === name);
      if (!srv) return;
      onSave(
        list.map((s) => (s.name === name ? { ...s, disabled: !s.disabled } : s)),
        scope,
      );
    },
    [scopeOf, projectServers, globalServers, onSave],
  );

  // ── Keyboard ──
  // CRITICAL: when form is active and a text field is focused, only handle
  // escape / tab / ctrl+s. Everything else must pass through to <input>.

  useKeyboard((evt) => {
    if (!visible) return;

    // ─── Detail mode ───
    if (view === "detail") {
      if (evt.name === "escape" || evt.name === "backspace") {
        setView("list");
        return;
      }
      if (evt.name === "return" || evt.name === " ") {
        setErrorExpanded((e) => !e);
        return;
      }
      if (evt.name === "e" && detailName) {
        openEdit(detailName);
        return;
      }
      if (evt.name === "r" && detailName && mcpManager) {
        mcpManager.reconnect(detailName);
        return;
      }
      if (evt.name === "p" && detailName && mcpManager) {
        const srv = runtimeServers[detailName];
        if (srv?.status === "ready") mcpManager.ping(detailName).catch(() => {});
        return;
      }
      if (evt.name === "d" && detailName) {
        toggleDisabled(detailName);
        return;
      }
      return;
    }

    // ─── Form mode ───
    if (view === "form") {
      if (evt.name === "escape") {
        setView("list");
        return;
      }
      if (evt.name === "s" && evt.ctrl) {
        commitForm();
        return;
      }
      if (evt.name === "tab") {
        const fields = fieldsFor(draft.transport);
        setActiveField((f) => {
          const idx = fields.indexOf(f);
          const next = evt.shift
            ? (idx - 1 + fields.length) % fields.length
            : (idx + 1) % fields.length;
          return fields[next] ?? "name";
        });
        return;
      }
      // Ctrl+T: cycle transport, Ctrl+G: cycle scope
      if (evt.name === "t" && evt.ctrl) {
        setDraft((d) => {
          const idx = TRANSPORTS.indexOf(d.transport);
          const next = TRANSPORTS[(idx + 1) % TRANSPORTS.length] ?? "stdio";
          // Reset activeField if it doesn't exist in the new transport's fields
          const newFields = fieldsFor(next);
          setActiveField((f) => (newFields.includes(f) ? f : (newFields[0] ?? "name")));
          return { ...d, transport: next };
        });
        return;
      }
      if (evt.name === "g" && evt.ctrl) {
        setDraft((d) => ({ ...d, scope: d.scope === "project" ? "global" : "project" }));
        return;
      }
      // Let <input> handle everything else
      return;
    }

    // ─── List/Tools mode ───
    if (evt.name === "escape") {
      if (view === "list" && serverFilter) {
        setServerFilter("");
        return;
      }
      if (view === "tools" && toolFilter) {
        setToolFilter("");
        return;
      }
      onClose();
      return;
    }
    if (evt.name === "tab" && !pendingDelete) {
      setView((v) => (v === "list" ? "tools" : "list"));
      return;
    }

    // Delete confirmation must be checked before arrow nav
    if (view === "list" && pendingDelete) {
      if (evt.name === "escape") {
        setPendingDelete(null);
        return;
      }
      if (
        evt.name === "left" ||
        evt.name === "right" ||
        evt.name === "tab" ||
        evt.name === "up" ||
        evt.name === "down"
      ) {
        setDeleteChoice((c) => (c === "no" ? "yes" : "no"));
        return;
      }
      if (evt.name === "return") {
        if (deleteChoice === "yes") deleteServer(pendingDelete);
        setPendingDelete(null);
        setDeleteChoice("no");
        return;
      }
      return;
    }

    if (evt.name === "up") {
      setCursor((c) => {
        const n = c > 0 ? c - 1 : Math.max(0, listCount - 1);
        adjustScroll(n);
        return n;
      });
      return;
    }
    if (evt.name === "down") {
      setCursor((c) => {
        const n = c < listCount - 1 ? c + 1 : 0;
        adjustScroll(n);
        return n;
      });
      return;
    }

    if (view === "list") {
      const srv = filteredServers[cursor];

      if (evt.name === "return") {
        if (srv) {
          setDetailName(srv.config.name);
          setErrorExpanded(false);
          setView("detail");
        }
        return;
      }

      // Ctrl-key actions (don't conflict with type-to-filter)
      if (evt.name === "a" && evt.ctrl) {
        openAdd();
        return;
      }
      if (srv && evt.name === "e" && evt.ctrl) {
        openEdit(srv.config.name);
        return;
      }
      if (srv && evt.name === "d" && evt.ctrl) {
        setPendingDelete(srv.config.name);
        setDeleteChoice("no");
        return;
      }
      if (
        srv &&
        evt.name === "r" &&
        evt.ctrl &&
        srv.status !== "ready" &&
        srv.status !== "connecting" &&
        mcpManager
      ) {
        mcpManager.reconnect(srv.config.name);
        return;
      }
      if (srv && evt.name === "p" && evt.ctrl && srv.status === "ready" && mcpManager) {
        mcpManager.ping(srv.config.name).catch(() => {});
        return;
      }
      if (evt.name === "t" && evt.ctrl) {
        if (srv) toggleDisabled(srv.config.name);
        return;
      }
    }

    // ─── Type to filter (shared by list + tools) ───
    const setFilter = view === "list" ? setServerFilter : view === "tools" ? setToolFilter : null;
    if (!setFilter) return;

    if (evt.name === "backspace" || evt.name === "delete") {
      setFilter((f: string) => f.slice(0, -1));
      resetScroll();
      return;
    }
    if (evt.name === "space") {
      setFilter((f: string) => `${f} `);
      resetScroll();
      return;
    }
    if (evt.name && evt.name.length === 1 && !evt.ctrl && !evt.meta) {
      setFilter((f: string) => f + evt.name);
      resetScroll();
    }
  });

  if (!visible) return null;
  const isForm = view === "form";

  return (
    <Overlay>
      <box
        flexDirection="column"
        borderStyle="rounded"
        border={true}
        borderColor={readyCount > 0 ? t.brand : t.border}
        width={popupWidth}
      >
        {/* Header */}
        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg={t.brand} attributes={TextAttributes.BOLD}>
            {icon("mcp")}
          </text>
          <text bg={POPUP_BG} fg={t.textPrimary} attributes={TextAttributes.BOLD}>
            {" Model Context Protocol"}
          </text>
          {view === "detail" && detailName ? (
            <text bg={POPUP_BG} fg={t.brandAlt}>
              {"  "}
              {icon("info")} {detailName}
            </text>
          ) : isForm ? (
            <text bg={POPUP_BG} fg={t.brandAlt}>
              {"  "}
              {editingName ? `${icon("edit")} Edit` : `${icon("create")} Add`}
              {" Server"}
            </text>
          ) : (
            <text bg={POPUP_BG} fg={t.textMuted}>
              {"  "}
              {readyCount}/{serverList.length} active {"  "}
              {icon("mcp_tool")} {allTools.length} tools
            </text>
          )}
        </PopupRow>

        {!isForm && view !== "detail" && <TabRow view={view} innerW={innerW} />}
        <Sep w={innerW} />

        {/* Body */}
        {view === "detail" && detailName && runtimeServers[detailName] ? (
          <ServerDetail
            server={runtimeServers[detailName]}
            scope={scopeOf(detailName)}
            errorExpanded={errorExpanded}
            innerW={innerW}
          />
        ) : isForm ? (
          <FormBody
            draft={draft}
            setDraft={setDraft}
            activeField={activeField}
            setActiveField={setActiveField}
            onSave={commitForm}
            innerW={innerW}
            focused={visible}
          />
        ) : view === "list" && serverList.length === 0 ? (
          <EmptyState innerW={innerW} />
        ) : view === "list" ? (
          <box flexDirection="column">
            <PopupRow w={innerW}>
              <text fg={t.brand} bg={POPUP_BG}>
                {"\uD83D\uDD0D "}
              </text>
              <text fg={t.textPrimary} attributes={TextAttributes.BOLD} bg={POPUP_BG}>
                {serverFilter}
              </text>
              <text fg={t.brandAlt} bg={POPUP_BG}>
                {"\u258E"}
              </text>
              {!serverFilter ? (
                <text fg={t.textDim} bg={POPUP_BG}>
                  {" type to filter…"}
                </text>
              ) : (
                <text fg={t.textMuted} bg={POPUP_BG}>
                  {` ${filteredServers.length} result${filteredServers.length === 1 ? "" : "s"}`}
                </text>
              )}
            </PopupRow>
            <PopupRow w={innerW}>
              <text fg={t.textSubtle} bg={POPUP_BG}>
                {"─".repeat(innerW - 4)}
              </text>
            </PopupRow>
            <box
              flexDirection="column"
              height={Math.min(filteredServers.length, serverPageSize) * 3}
              overflow="hidden"
            >
              {filteredServers.slice(scrollOffset, scrollOffset + serverPageSize).map((srv, vi) => (
                <ServerCard
                  key={srv.config.name}
                  server={srv}
                  scope={scopeOf(srv.config.name)}
                  isSelected={scrollOffset + vi === cursor}
                  pendingDelete={pendingDelete === srv.config.name}
                  deleteChoice={deleteChoice}
                  innerW={innerW}
                />
              ))}
            </box>
            {filteredServers.length === 0 && serverFilter && (
              <PopupRow w={innerW}>
                <text bg={POPUP_BG} fg={t.textDim}>
                  {"  No matches"}
                </text>
              </PopupRow>
            )}
          </box>
        ) : (
          <ToolBrowser
            tools={filteredTools}
            filter={toolFilter}
            cursor={cursor}
            scrollOffset={scrollOffset}
            maxVisible={toolPageSize}
            innerW={innerW}
          />
        )}

        {/* Scroll */}
        {!isForm && listCount > pageSize && (
          <PopupRow w={innerW}>
            <text fg={t.textMuted} bg={POPUP_BG}>
              {"  "}
              {scrollOffset > 0 ? "↑ " : "  "}
              {cursor + 1}/{listCount}
              {scrollOffset + pageSize < listCount ? " ↓" : ""}
            </text>
          </PopupRow>
        )}

        {/* Scope legend */}
        {view === "list" && serverList.length > 0 && (
          <>
            <Sep w={innerW} />
            <PopupRow w={innerW}>
              <text bg={POPUP_BG} fg={t.brandAlt} attributes={TextAttributes.BOLD}>
                {" P"}
              </text>
              <text bg={POPUP_BG} fg={t.textDim}>
                {" project  "}
              </text>
              <text bg={POPUP_BG} fg={t.textMuted} attributes={TextAttributes.BOLD}>
                {"G"}
              </text>
              <text bg={POPUP_BG} fg={t.textDim}>
                {" global"}
              </text>
            </PopupRow>
          </>
        )}

        <Sep w={innerW} />

        <Footer view={view} isForm={isForm} innerW={innerW} detailName={detailName} />
      </box>
    </Overlay>
  );
}

// ─── Small pieces ─────────────────────────────────────────

function Sep({ w }: { w: number }) {
  const t = useTheme();
  return (
    <PopupRow w={w}>
      <text bg={POPUP_BG} fg={t.textFaint}>
        {"─".repeat(w - 2)}
      </text>
    </PopupRow>
  );
}

const MCP_TABS: { id: "list" | "tools"; label: string; ic: string }[] = [
  { id: "list", label: "Servers", ic: "server" },
  { id: "tools", label: "Tools", ic: "mcp_tool" },
];

const TabRow = memo(function TabRow({ view, innerW }: { view: View; innerW: number }) {
  const t = useTheme();
  return (
    <PopupRow w={innerW}>
      {MCP_TABS.map((tab, i) => {
        const selected = view === tab.id;
        return (
          <text key={tab.id} bg={POPUP_BG}>
            {i > 0 ? (
              <span fg={t.textFaint} bg={POPUP_BG}>
                {" │ "}
              </span>
            ) : (
              ""
            )}
            <span
              fg={selected ? t.brand : t.textMuted}
              bg={selected ? POPUP_HL : POPUP_BG}
              attributes={selected ? TextAttributes.BOLD : undefined}
            >
              {` ${icon(tab.ic)} ${tab.label} `}
            </span>
          </text>
        );
      })}
    </PopupRow>
  );
});

function K({ children, c }: { children: string; c?: string }) {
  const t = useTheme();
  return (
    <text bg={POPUP_BG} fg={c ?? t.textSecondary} attributes={TextAttributes.BOLD}>
      {children}
    </text>
  );
}
function L({ children }: { children: string }) {
  const t = useTheme();
  return (
    <text bg={POPUP_BG} fg={t.textMuted}>
      {children}
    </text>
  );
}
function D() {
  const t = useTheme();
  return (
    <text bg={POPUP_BG} fg={t.textFaint}>
      {" │ "}
    </text>
  );
}

function Footer({
  view,
  isForm,
  innerW,
  detailName,
}: {
  view: View;
  isForm: boolean;
  innerW: number;
  detailName?: string | null;
}) {
  const t = useTheme();
  const detailStatus = useMCPStore((s) => (detailName ? s.servers[detailName]?.status : undefined));
  if (view === "detail")
    return (
      <PopupRow w={innerW}>
        <K>{"⏎"}</K>
        <L>{" expand error"}</L>
        <D />
        <K c={t.info}>{"<e>"}</K>
        <L>{" edit"}</L>
        <D />
        <K>{"<r>"}</K>
        <L>{" retry"}</L>
        <D />
        <K>{"<p>"}</K>
        <L>{" ping"}</L>
        <D />
        <K>{"<d>"}</K>
        <L>{detailStatus === "disabled" ? " enable" : " disable"}</L>
        <D />
        <K>{"esc"}</K>
        <L>{" back"}</L>
      </PopupRow>
    );
  if (isForm)
    return (
      <PopupRow w={innerW}>
        <K>{"tab"}</K>
        <L>{" next"}</L>
        <D />
        <K c={t.success}>{"^S"}</K>
        <L>{" save"}</L>
        <D />
        <K>{"⏎"}</K>
        <L>{" next"}</L>
        <D />
        <K>{"^T"}</K>
        <L>{" transport"}</L>
        <D />
        <K>{"^G"}</K>
        <L>{" scope"}</L>
        <D />
        <K>{"esc"}</K>
        <L>{" cancel"}</L>
      </PopupRow>
    );
  if (view === "list")
    return (
      <PopupRow w={innerW}>
        <K>{"↑↓"}</K>
        <L>{" nav"}</L>
        <D />
        <L>{"type to filter"}</L>
        <D />
        <K c={t.success}>{"^A"}</K>
        <L>{" add"}</L>
        <D />
        <K>{"^D"}</K>
        <L>{" del"}</L>
        <D />
        <K>{"^T"}</K>
        <L>{" toggle"}</L>
        <D />
        <K>{"⏎"}</K>
        <L>{" detail"}</L>
        <D />
        <K>{"tab"}</K>
        <D />
        <K>{"esc"}</K>
      </PopupRow>
    );
  return (
    <PopupRow w={innerW}>
      <K>{"↑↓"}</K>
      <L>{" nav"}</L>
      <D />
      <L>{"type to filter"}</L>
      <D />
      <K>{"tab"}</K>
      <L>{" switch"}</L>
      <D />
      <K>{"esc"}</K>
      <L>{" close"}</L>
    </PopupRow>
  );
}

const EmptyState = memo(function EmptyState({ innerW }: { innerW: number }) {
  const t = useTheme();
  return (
    <box flexDirection="column">
      <PopupRow w={innerW}>
        <text bg={POPUP_BG} />
      </PopupRow>
      <PopupRow w={innerW}>
        <text bg={POPUP_BG} fg={t.textMuted}>
          {"  "}
          {icon("unplug")} No MCP servers configured
        </text>
      </PopupRow>
      <PopupRow w={innerW}>
        <text bg={POPUP_BG} />
      </PopupRow>
      <PopupRow w={innerW}>
        <text bg={POPUP_BG} fg={t.textDim}>
          {"  Press "}
        </text>
        <text bg={POPUP_BG} fg={t.success} attributes={TextAttributes.BOLD}>
          {"ctrl+a"}
        </text>
        <text bg={POPUP_BG} fg={t.textDim}>
          {" to add your first MCP server"}
        </text>
      </PopupRow>
      <PopupRow w={innerW}>
        <text bg={POPUP_BG} />
      </PopupRow>
    </box>
  );
});

// ─── Server Card ──────────────────────────────────────────

const ServerCard = memo(function ServerCard({
  server,
  scope,
  isSelected,
  pendingDelete,
  deleteChoice,
  innerW,
}: {
  server: MCPServerState;
  scope: ConfigScope;
  isSelected: boolean;
  pendingDelete?: boolean;
  deleteChoice?: "no" | "yes";
  innerW: number;
}) {
  const t = useTheme();
  const bg = isSelected ? POPUP_HL : POPUP_BG;
  const { config, status, tools, error, lastPingMs, connectedAt } = server;
  const sc = statusColor(status, t);
  const scopeBadge = scope === "project" ? "P" : "G";
  const scopeCol = scope === "project" ? t.brandAlt : t.textMuted;

  return (
    <box flexDirection="column">
      {/* Row 1: status + name + meta */}
      <PopupRow bg={bg} w={innerW}>
        <text bg={bg} fg={isSelected ? t.brandSecondary : t.textDim}>
          {isSelected ? "▸ " : "  "}
        </text>
        <text bg={bg} fg={scopeCol} attributes={TextAttributes.BOLD}>
          {scopeBadge}
        </text>
        <text bg={bg} fg={t.textDim}>
          {" "}
        </text>
        {status === "connecting" ? (
          <Spinner color={t.warning} />
        ) : (
          <text bg={bg} fg={sc}>
            {statusIcon(status)}
          </text>
        )}
        <text bg={bg} fg={sc}>
          {" "}
        </text>
        <text bg={bg} fg={isSelected ? "white" : t.textPrimary} attributes={TextAttributes.BOLD}>
          {config.name}
        </text>
        <text bg={bg} fg={t.textDim}>
          {"  "}
          {config.transport === "http"
            ? icon("globe")
            : config.transport === "sse"
              ? icon("cloud")
              : icon("terminal")}
          {"  "}
        </text>
        <text bg={bg} fg={status === "ready" ? t.success : t.textMuted}>
          {STATUS_LABEL[status]}
        </text>
        {tools.length > 0 && (
          <text bg={bg} fg={t.info}>
            {"  "}
            {icon("mcp_tool")} {tools.length}
          </text>
        )}
        {lastPingMs != null && (
          <text bg={bg} fg={lastPingMs < 100 ? t.success : lastPingMs < 500 ? t.warning : t.error}>
            {"  "}
            {icon("pulse")} {lastPingMs}ms
          </text>
        )}
        {connectedAt && (
          <text bg={bg} fg={t.textDim}>
            {"  "}
            {icon("clock")} {uptime(Date.now() - connectedAt)}
          </text>
        )}
      </PopupRow>

      {/* Row 2: detail or delete confirmation */}
      {pendingDelete ? (
        <PopupRow bg={bg} w={innerW}>
          <text bg={bg} fg={t.error}>
            {"    "}
            {icon("warning")} Delete?{"  "}
          </text>
          <text
            bg={deleteChoice === "no" ? POPUP_HL : bg}
            fg={deleteChoice === "no" ? "white" : t.textDim}
            attributes={deleteChoice === "no" ? TextAttributes.BOLD : undefined}
          >
            {deleteChoice === "no" ? " ▸ No " : "   No "}
          </text>
          <text bg={bg} fg={t.textDim}>
            {" "}
          </text>
          <text
            bg={deleteChoice === "yes" ? POPUP_HL : bg}
            fg={deleteChoice === "yes" ? t.error : t.textDim}
            attributes={deleteChoice === "yes" ? TextAttributes.BOLD : undefined}
          >
            {deleteChoice === "yes" ? " ▸ Yes " : "   Yes "}
          </text>
        </PopupRow>
      ) : (
        <PopupRow bg={bg} w={innerW}>
          <text bg={bg} fg={t.textDim}>
            {"      "}
          </text>
          {error ? (
            <text bg={bg} fg={t.error} truncate>
              {error.slice(0, innerW - 10)}
            </text>
          ) : config.command ? (
            <text bg={bg} fg={t.textDim} truncate>
              {`${config.command} ${(config.args ?? []).join(" ")}`.slice(0, innerW - 10)}
            </text>
          ) : config.url ? (
            <text bg={bg} fg={t.textDim} truncate>
              {config.url.slice(0, innerW - 10)}
            </text>
          ) : (
            <text bg={bg} fg={t.textDim}>
              {"—"}
            </text>
          )}
        </PopupRow>
      )}

      {/* Separator */}
      <PopupRow bg={POPUP_BG} w={innerW}>
        <text bg={POPUP_BG} fg={t.textSubtle}>
          {`  ${"╌".repeat(Math.max(0, innerW - 4))}`}
        </text>
      </PopupRow>
    </box>
  );
});

// ─── Server Detail ────────────────────────────────────────

function ServerDetail({
  server,
  scope,
  errorExpanded,
  innerW,
}: {
  server: MCPServerState;
  scope: ConfigScope;
  errorExpanded: boolean;
  innerW: number;
}) {
  const t = useTheme();
  const { config, status, tools, error, lastPingMs, connectedAt } = server;
  const sc = statusColor(status, t);
  const scopeLabel = scope === "project" ? "project" : "global";

  return (
    <box flexDirection="column">
      {/* Server header */}
      <PopupRow w={innerW}>
        <text bg={POPUP_BG} fg={t.textDim}>
          {"  "}
        </text>
        {status === "connecting" ? (
          <Spinner color={t.warning} />
        ) : (
          <text fg={sc}>{statusIcon(status)}</text>
        )}
        <text fg={sc}> </text>
        <text fg={t.textPrimary} attributes={TextAttributes.BOLD} bg={POPUP_BG}>
          {config.name}
        </text>
        <text fg={sc} bg={POPUP_BG}>
          {"  "}
          {STATUS_LABEL[status]}
        </text>
      </PopupRow>

      <PopupRow w={innerW}>
        <text bg={POPUP_BG} />
      </PopupRow>

      {/* Info rows */}
      <DetailRow
        label="Scope"
        value={scopeLabel}
        color={scope === "project" ? t.brandAlt : t.textMuted}
        innerW={innerW}
      />
      <DetailRow
        label="Transport"
        value={
          config.transport === "http"
            ? `http → ${config.url ?? "—"}`
            : config.transport === "sse"
              ? `sse → ${config.url ?? "—"}`
              : "stdio"
        }
        color={t.textSecondary}
        innerW={innerW}
      />
      {config.command && (
        <DetailRow
          label="Command"
          value={`${config.command} ${(config.args ?? []).join(" ")}`}
          color={t.textSecondary}
          innerW={innerW}
        />
      )}
      {config.env && (
        <DetailRow
          label="Env"
          value={Object.keys(config.env).join(", ")}
          color={t.textSecondary}
          innerW={innerW}
        />
      )}
      {connectedAt && (
        <DetailRow
          label="Uptime"
          value={uptime(Date.now() - connectedAt)}
          color={t.success}
          innerW={innerW}
        />
      )}
      {lastPingMs != null && (
        <DetailRow
          label="Latency"
          value={`${lastPingMs}ms`}
          color={lastPingMs < 100 ? t.success : lastPingMs < 500 ? t.warning : t.error}
          innerW={innerW}
        />
      )}
      <DetailRow
        label="Tools"
        value={tools.length > 0 ? `${tools.length} registered` : "none"}
        color={tools.length > 0 ? t.info : t.textDim}
        innerW={innerW}
      />

      {/* Tool names */}
      {tools.length > 0 && (
        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg={t.textDim}>
            {"    "}
          </text>
          <text bg={POPUP_BG} fg={t.textMuted} truncate>
            {tools
              .map((t) => t.name)
              .join(", ")
              .slice(0, innerW - 8)}
          </text>
        </PopupRow>
      )}

      <PopupRow w={innerW}>
        <text bg={POPUP_BG} />
      </PopupRow>

      {/* Error section */}
      {error && (
        <box flexDirection="column">
          <PopupRow w={innerW}>
            <text bg={POPUP_BG} fg={t.error} attributes={TextAttributes.BOLD}>
              {"  "}
              {icon("error")} Error {errorExpanded ? "▾" : "▸"}
            </text>
            <text bg={POPUP_BG} fg={t.textDim}>
              {"  (⏎ to "}
              {errorExpanded ? "collapse" : "expand"}
              {")"}
            </text>
          </PopupRow>
          {errorExpanded ? (
            <box flexDirection="column" paddingLeft={4} paddingRight={2}>
              <box
                borderStyle="rounded"
                border={true}
                borderColor={t.error}
                width={innerW - 6}
                backgroundColor={t.bgBannerError}
                paddingX={1}
                paddingY={0}
              >
                <text fg={t.error}>{error}</text>
              </box>
            </box>
          ) : (
            <PopupRow w={innerW}>
              <text bg={POPUP_BG} fg={t.error}>
                {"    "}
              </text>
              <text bg={POPUP_BG} fg={t.error} truncate>
                {error.slice(0, innerW - 8)}
              </text>
            </PopupRow>
          )}
        </box>
      )}

      {!error && status === "ready" && (
        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg={t.success}>
            {"  "}
            {icon("success")} Server healthy
          </text>
        </PopupRow>
      )}

      {!error && status === "connecting" && (
        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg={t.warning}>
            {"  "}
          </text>
          <Spinner color={t.warning} />
          <text bg={POPUP_BG} fg={t.warning}>
            {" Connecting…"}
          </text>
        </PopupRow>
      )}

      <PopupRow w={innerW}>
        <text bg={POPUP_BG} />
      </PopupRow>
    </box>
  );
}

function DetailRow({
  label,
  value,
  color,
  innerW,
}: {
  label: string;
  value: string;
  color: string;
  innerW: number;
}) {
  const t = useTheme();
  return (
    <PopupRow w={innerW}>
      <text bg={POPUP_BG} fg={t.textDim}>
        {"  "}
        {label.padEnd(12)}
      </text>
      <text bg={POPUP_BG} fg={color} truncate>
        {value.slice(0, innerW - 16)}
      </text>
    </PopupRow>
  );
}

// ─── Tool Browser ─────────────────────────────────────────

const ToolBrowser = memo(function ToolBrowser({
  tools,
  filter,
  cursor,
  scrollOffset,
  maxVisible,
  innerW,
}: {
  tools: { name: string; description: string; serverName: string; serverStatus: MCPServerStatus }[];
  filter: string;
  cursor: number;
  scrollOffset: number;
  maxVisible: number;
  innerW: number;
}) {
  const t = useTheme();
  const visible = tools.slice(scrollOffset, scrollOffset + maxVisible);
  return (
    <box flexDirection="column">
      <PopupRow w={innerW}>
        <text fg={t.brand} bg={POPUP_BG}>
          {"\uD83D\uDD0D "}
        </text>
        <text fg={t.textPrimary} attributes={TextAttributes.BOLD} bg={POPUP_BG}>
          {filter}
        </text>
        <text fg={t.brandAlt} bg={POPUP_BG}>
          {"\u258E"}
        </text>
        {!filter ? (
          <text fg={t.textDim} bg={POPUP_BG}>
            {" type to filter…"}
          </text>
        ) : (
          <text fg={t.textMuted} bg={POPUP_BG}>
            {` ${tools.length} result${tools.length === 1 ? "" : "s"}`}
          </text>
        )}
      </PopupRow>
      <PopupRow w={innerW}>
        <text fg={t.textSubtle} bg={POPUP_BG}>
          {"─".repeat(innerW - 4)}
        </text>
      </PopupRow>
      <box flexDirection="column" height={Math.min(tools.length, maxVisible) * 2} overflow="hidden">
        {visible.map((tool, vi) => {
          const i = vi + scrollOffset;
          const sel = i === cursor;
          const bg = sel ? POPUP_HL : POPUP_BG;
          return (
            <box key={`${tool.serverName}/${tool.name}`} flexDirection="column">
              <PopupRow bg={bg} w={innerW}>
                <text bg={bg} fg={sel ? t.brandSecondary : t.textDim}>
                  {sel ? "▸ " : "  "}
                </text>
                <text bg={bg} fg={tool.serverStatus === "ready" ? t.success : t.textMuted}>
                  {tool.serverName}
                </text>
                <text bg={bg} fg={t.textDim}>
                  {icon("chevron_right")}
                </text>
                <text bg={bg} fg={sel ? "white" : t.info} attributes={TextAttributes.BOLD}>
                  {tool.name}
                </text>
              </PopupRow>
              <PopupRow bg={bg} w={innerW}>
                <text bg={bg} fg={t.textDim}>
                  {"    "}
                </text>
                <text bg={bg} fg={t.textMuted} truncate>
                  {tool.description.slice(0, innerW - 8)}
                </text>
              </PopupRow>
            </box>
          );
        })}
      </box>
      {tools.length === 0 && (
        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg={t.textDim}>
            {"  "}
            {filter ? "No matches" : "No tools"}
          </text>
        </PopupRow>
      )}
    </box>
  );
});

// ─── Form ─────────────────────────────────────────────────

function FormBody({
  draft,
  setDraft,
  activeField,
  setActiveField,
  onSave,
  innerW,
  focused,
}: {
  draft: Draft;
  setDraft: React.Dispatch<React.SetStateAction<Draft>>;
  activeField: Field;
  setActiveField: React.Dispatch<React.SetStateAction<Field>>;
  onSave: () => void;
  innerW: number;
  focused: boolean;
}) {
  const t = useTheme();
  const fields = fieldsFor(draft.transport);
  const inputW = Math.max(30, innerW - 8);

  const advanceField = useCallback(() => {
    const idx = fields.indexOf(activeField);
    const next = fields[idx + 1];
    if (next) setActiveField(next);
    else onSave();
  }, [fields, activeField, setActiveField, onSave]);

  return (
    <box flexDirection="column">
      {/* Transport toggle row */}
      <PopupRow w={innerW}>
        <text bg={POPUP_BG} fg={t.textMuted}>
          {"  Transport   "}
        </text>
        {TRANSPORTS.map((tr) => (
          <text
            key={tr}
            bg={POPUP_BG}
            fg={draft.transport === tr ? t.brand : t.textDim}
            attributes={draft.transport === tr ? TextAttributes.BOLD : undefined}
          >
            {draft.transport === tr ? `[${TRANSPORT_LABEL[tr]}]` : ` ${TRANSPORT_LABEL[tr]} `}
            {"  "}
          </text>
        ))}
        <text bg={POPUP_BG} fg={t.textDim}>
          {"(^T cycle)"}
        </text>
      </PopupRow>

      {/* Scope toggle row */}
      <PopupRow w={innerW}>
        <text bg={POPUP_BG} fg={t.textMuted}>
          {"  Scope       "}
        </text>
        <text
          bg={POPUP_BG}
          fg={draft.scope === "project" ? t.brandAlt : t.textDim}
          attributes={draft.scope === "project" ? TextAttributes.BOLD : undefined}
        >
          {draft.scope === "project" ? "[project]" : " project "}
        </text>
        <text bg={POPUP_BG} fg={t.textDim}>
          {"  "}
        </text>
        <text
          bg={POPUP_BG}
          fg={draft.scope === "global" ? t.brandAlt : t.textDim}
          attributes={draft.scope === "global" ? TextAttributes.BOLD : undefined}
        >
          {draft.scope === "global" ? "[global]" : " global "}
        </text>
        <text bg={POPUP_BG} fg={t.textDim}>
          {"   (^G toggle)"}
        </text>
      </PopupRow>

      <Sep w={innerW} />

      {/* Input fields */}
      {fields.map((field) => {
        const active = activeField === field;
        const bg = active ? POPUP_HL : POPUP_BG;

        return (
          <box key={field} flexDirection="column">
            <PopupRow bg={bg} w={innerW}>
              <text bg={bg} fg={active ? t.brandSecondary : t.textDim}>
                {active ? "▸ " : "  "}
              </text>
              <text
                bg={bg}
                fg={active ? t.brand : t.textMuted}
                attributes={active ? TextAttributes.BOLD : undefined}
              >
                {LABEL[field].padEnd(12)}
              </text>
              {!active && (
                <text bg={bg} fg={t.textSecondary}>
                  {draft[field] || "—"}
                </text>
              )}
            </PopupRow>
            {active && (
              <box paddingLeft={4} paddingRight={2} width={innerW} backgroundColor={POPUP_BG}>
                <box
                  borderStyle="rounded"
                  border={true}
                  borderColor={t.brandDim}
                  width={inputW}
                  backgroundColor={POPUP_BG}
                  paddingX={1}
                >
                  <input
                    value={draft[field]}
                    onInput={(v: string) => setDraft((d) => ({ ...d, [field]: v }))}
                    onSubmit={advanceField}
                    placeholder={HINT[field]}
                    focused={focused && active}
                    backgroundColor={POPUP_BG}
                  />
                </box>
              </box>
            )}
          </box>
        );
      })}

      <PopupRow w={innerW}>
        <text bg={POPUP_BG} />
      </PopupRow>
    </box>
  );
}
