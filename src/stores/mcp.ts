import { create } from "zustand";
import type { MCPServerConfig } from "../types/index.js";

export type MCPServerStatus = "disconnected" | "connecting" | "ready" | "error" | "disabled";

export interface MCPToolInfo {
  name: string;
  description: string;
  serverName: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPServerState {
  config: MCPServerConfig;
  status: MCPServerStatus;
  tools: MCPToolInfo[];
  error: string | null;
  connectedAt: number | null;
  lastPingMs: number | null;
}

interface MCPStoreState {
  servers: Record<string, MCPServerState>;

  /** Called by MCPManager.connectAll — rebuilds store from config list */
  setServers: (configs: MCPServerConfig[]) => void;
  setServerStatus: (name: string, status: MCPServerStatus, error?: string | null) => void;
  setServerTools: (name: string, tools: MCPToolInfo[]) => void;
  setServerPing: (name: string, ms: number) => void;
  removeServer: (name: string) => void;
}

export const useMCPStore = create<MCPStoreState>()((set) => ({
  servers: {},

  setServers: (configs) =>
    set((prev) => {
      const servers: Record<string, MCPServerState> = {};
      for (const config of configs) {
        const existing = prev.servers[config.name];
        // Preserve live state for servers whose disabled flag hasn't changed
        if (existing && Boolean(config.disabled) === (existing.status === "disabled")) {
          servers[config.name] = { ...existing, config };
        } else {
          servers[config.name] = {
            config,
            status: config.disabled ? "disabled" : "disconnected",
            tools: config.disabled ? [] : (existing?.tools ?? []),
            error: null,
            connectedAt: null,
            lastPingMs: null,
          };
        }
      }
      return { servers };
    }),

  setServerStatus: (name, status, error) =>
    set((s) => {
      const srv = s.servers[name];
      if (!srv) return s;
      return {
        servers: {
          ...s.servers,
          [name]: {
            ...srv,
            status,
            error: error ?? (status === "error" ? srv.error : null),
            connectedAt: status === "ready" ? Date.now() : srv.connectedAt,
          },
        },
      };
    }),

  setServerTools: (name, tools) =>
    set((s) => {
      const srv = s.servers[name];
      if (!srv) return s;
      return { servers: { ...s.servers, [name]: { ...srv, tools } } };
    }),

  setServerPing: (name, ms) =>
    set((s) => {
      const srv = s.servers[name];
      if (!srv) return s;
      return { servers: { ...s.servers, [name]: { ...srv, lastPingMs: ms } } };
    }),

  removeServer: (name) =>
    set((s) => {
      const { [name]: _, ...rest } = s.servers;
      return { servers: rest };
    }),
}));
