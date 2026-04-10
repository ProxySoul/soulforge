import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logBackgroundError } from "../../stores/errors.js";
import type { ChatMessage } from "../../types/index.js";
import { ensureSoulforgeDir } from "../utils/ensure-soulforge-dir.js";
import { getIOClient } from "../workers/io-client.js";
import { rebuildCoreMessages } from "./rebuild.js";
import type { SessionMeta, TabMeta } from "./types.js";

export interface SessionListEntry {
  id: string;
  title: string;
  messageCount: number;
  startedAt: number;
  updatedAt: number;
  sizeBytes: number;
}

export class SessionManager {
  private dir: string;
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.dir = join(cwd, ".soulforge", "sessions");
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) {
      ensureSoulforgeDir(this.cwd);
      mkdirSync(this.dir, { recursive: true });
    }
  }

  private sessionDirSize(sessionDir: string): number {
    let total = 0;
    for (const file of ["meta.json", "messages.jsonl"]) {
      try {
        total += statSync(join(sessionDir, file)).size;
      } catch {
        // file may not exist
      }
    }
    return total;
  }

  async saveSession(
    meta: SessionMeta,
    tabMessages: Map<string, ChatMessage[]>,
    tabCoreMessages?: Map<string, import("ai").ModelMessage[]>,
  ): Promise<void> {
    this.ensureDir();
    const sessionDir = join(this.dir, meta.id);

    try {
      const io = getIOClient();
      const coreEntries = tabCoreMessages
        ? ([...tabCoreMessages.entries()] as [string, import("ai").ModelMessage[]][])
        : undefined;
      await io.saveSession(sessionDir, meta, [...tabMessages.entries()], coreEntries);
      return;
    } catch {
      // IO worker unavailable — fall back to local serialization
    }

    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    }

    const allMessages: ChatMessage[] = [];
    const updatedTabs: TabMeta[] = [];

    for (const tab of meta.tabs) {
      const msgs = tabMessages.get(tab.id) ?? [];
      const startLine = allMessages.length;
      for (const msg of msgs) {
        allMessages.push(msg);
      }
      const endLine = allMessages.length;
      updatedTabs.push({ ...tab, messageRange: { startLine, endLine } });
    }

    const updatedMeta: SessionMeta = { ...meta, tabs: updatedTabs };
    const metaPath = join(sessionDir, "meta.json");
    const jsonlPath = join(sessionDir, "messages.jsonl");
    const lines = allMessages.map((m) => JSON.stringify(m)).join("\n");

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const metaTmp = `${metaPath}.${suffix}.tmp`;
    const jsonlTmp = `${jsonlPath}.${suffix}.tmp`;
    await writeFile(metaTmp, JSON.stringify(updatedMeta, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    await writeFile(jsonlTmp, lines ? `${lines}\n` : "", { encoding: "utf-8", mode: 0o600 });
    await rename(jsonlTmp, jsonlPath);
    await rename(metaTmp, metaPath);

    // Save core messages (API-facing, survives compaction)
    if (tabCoreMessages) {
      const coreData: Record<string, import("ai").ModelMessage[]> = {};
      for (const [tabId, cores] of tabCoreMessages) {
        coreData[tabId] = cores;
      }
      const corePath = join(sessionDir, "core.json");
      const coreTmp = `${corePath}.${suffix}.tmp`;
      await writeFile(coreTmp, JSON.stringify(coreData), { encoding: "utf-8", mode: 0o600 });
      await rename(coreTmp, corePath);
    }
  }

  loadSession(id: string): {
    meta: SessionMeta;
    tabMessages: Map<string, ChatMessage[]>;
    tabCoreMessages?: Map<string, import("ai").ModelMessage[]>;
  } | null {
    const sessionDir = join(this.dir, id);
    const metaPath = join(sessionDir, "meta.json");
    if (!existsSync(metaPath)) return null;

    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as SessionMeta;
      const jsonlPath = join(sessionDir, "messages.jsonl");
      const allMessages: ChatMessage[] = [];

      if (existsSync(jsonlPath)) {
        const content = readFileSync(jsonlPath, "utf-8").trim();
        if (content) {
          for (const line of content.split("\n")) {
            if (!line.trim()) continue;
            try {
              allMessages.push(JSON.parse(line) as ChatMessage);
            } catch {
              break;
            }
          }
        }
      }

      const tabMessages = new Map<string, ChatMessage[]>();
      for (const tab of meta.tabs) {
        const { startLine, endLine } = tab.messageRange;
        tabMessages.set(tab.id, allMessages.slice(startLine, endLine));
      }

      // Load saved core messages (API-facing, survives compaction)
      const corePath = join(sessionDir, "core.json");
      let tabCoreMessages: Map<string, import("ai").ModelMessage[]> | undefined;
      if (existsSync(corePath)) {
        try {
          const coreData = JSON.parse(readFileSync(corePath, "utf-8")) as Record<
            string,
            import("ai").ModelMessage[]
          >;
          tabCoreMessages = new Map();
          for (const [tabId, cores] of Object.entries(coreData)) {
            tabCoreMessages.set(tabId, cores);
          }
        } catch {
          /* ignore corrupt core.json — will fall back to rebuild */
        }
      }

      return { meta, tabMessages, tabCoreMessages };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logBackgroundError("session-load", `Failed to load session ${id}: ${msg}`);
      return null;
    }
  }

  async loadSessionAsync(id: string): Promise<{
    meta: SessionMeta;
    tabMessages: Map<string, ChatMessage[]>;
    tabCoreMessages?: Map<string, import("ai").ModelMessage[]>;
  } | null> {
    const sessionDir = join(this.dir, id);
    try {
      const io = getIOClient();
      const result = await io.loadSession(sessionDir);
      if (!result) return null;
      const tabMessages = new Map<string, ChatMessage[]>();
      for (const [tabId, msgs] of result.tabEntries) {
        tabMessages.set(tabId, msgs);
      }
      let tabCoreMessages: Map<string, import("ai").ModelMessage[]> | undefined;
      if (result.coreEntries) {
        tabCoreMessages = new Map();
        for (const [tabId, cores] of result.coreEntries) {
          tabCoreMessages.set(tabId, cores as import("ai").ModelMessage[]);
        }
      }
      return { meta: result.meta, tabMessages, tabCoreMessages };
    } catch {
      return this.loadSession(id);
    }
  }

  loadSessionMessages(
    id: string,
  ): { messages: ChatMessage[]; coreMessages: import("ai").ModelMessage[] } | null {
    const data = this.loadSession(id);
    if (!data) return null;
    const firstTab = data.meta.tabs[0];
    if (!firstTab) return null;
    const msgs = data.tabMessages.get(firstTab.id) ?? [];
    const savedCore = data.tabCoreMessages?.get(firstTab.id);
    return { messages: msgs, coreMessages: savedCore ?? rebuildCoreMessages(msgs) };
  }

  findByPrefix(prefix: string): string | null {
    if (!existsSync(this.dir)) return null;
    const normalizedPrefix = prefix.toLowerCase();

    const entries = readdirSync(this.dir);
    for (const entry of entries) {
      if (entry.toLowerCase().startsWith(normalizedPrefix)) {
        const metaPath = join(this.dir, entry, "meta.json");
        if (existsSync(metaPath)) return entry;
      }
    }
    return null;
  }

  listSessions(): SessionListEntry[] {
    if (!existsSync(this.dir)) return [];
    try {
      const entries = readdirSync(this.dir);
      const metas: SessionListEntry[] = [];

      for (const entry of entries) {
        try {
          const fullPath = join(this.dir, entry);
          const s = statSync(fullPath);
          if (!s.isDirectory()) continue;

          const metaPath = join(fullPath, "meta.json");
          if (!existsSync(metaPath)) continue;

          const raw = readFileSync(metaPath, "utf-8");
          const meta = JSON.parse(raw) as SessionMeta;
          const totalMessages = meta.tabs.reduce(
            (sum, t) => sum + (t.messageRange.endLine - t.messageRange.startLine),
            0,
          );
          metas.push({
            id: meta.id,
            title: meta.title,
            messageCount: totalMessages,
            startedAt: meta.startedAt,
            updatedAt: meta.updatedAt,
            sizeBytes: this.sessionDirSize(fullPath),
          });
        } catch {
          // Skip corrupted entries
        }
      }

      return metas.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }

  /** Async version — offloads FS scanning + JSON parsing to IO worker. */
  async listSessionsAsync(): Promise<SessionListEntry[]> {
    try {
      const io = getIOClient();
      return await io.listSessions(this.dir);
    } catch {
      return this.listSessions();
    }
  }

  /**
   * Synchronous save — used only for emergency crash-recovery writes
   * (signal handlers, uncaughtException). Never call from normal async paths.
   */
  saveSessionSync(
    meta: SessionMeta,
    tabMessages: Map<string, ChatMessage[]>,
    tabCoreMessages?: Map<string, import("ai").ModelMessage[]>,
  ): void {
    this.ensureDir();
    const sessionDir = join(this.dir, meta.id);
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    }

    const allMessages: ChatMessage[] = [];
    const updatedTabs: TabMeta[] = [];

    for (const tab of meta.tabs) {
      const msgs = tabMessages.get(tab.id) ?? [];
      const startLine = allMessages.length;
      for (const msg of msgs) allMessages.push(msg);
      const endLine = allMessages.length;
      updatedTabs.push({ ...tab, messageRange: { startLine, endLine } });
    }

    const updatedMeta: SessionMeta = { ...meta, tabs: updatedTabs };
    const metaPath = join(sessionDir, "meta.json");
    const jsonlPath = join(sessionDir, "messages.jsonl");
    const lines = allMessages.map((m) => JSON.stringify(m)).join("\n");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const metaTmp = `${metaPath}.${suffix}.tmp`;
    const jsonlTmp = `${jsonlPath}.${suffix}.tmp`;

    writeFileSync(metaTmp, JSON.stringify(updatedMeta, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    writeFileSync(jsonlTmp, lines ? `${lines}\n` : "", { encoding: "utf-8", mode: 0o600 });
    renameSync(jsonlTmp, jsonlPath);
    renameSync(metaTmp, metaPath);

    if (tabCoreMessages) {
      const coreData: Record<string, import("ai").ModelMessage[]> = {};
      for (const [tabId, cores] of tabCoreMessages) {
        coreData[tabId] = cores;
      }
      const corePath = join(sessionDir, "core.json");
      const coreTmp = `${corePath}.${suffix}.tmp`;
      writeFileSync(coreTmp, JSON.stringify(coreData), { encoding: "utf-8", mode: 0o600 });
      renameSync(coreTmp, corePath);
    }
  }

  deleteSession(id: string): boolean {
    const dir = join(this.dir, id);
    if (!existsSync(dir)) return false;
    rmSync(dir, { recursive: true });
    return true;
  }

  renameSession(id: string, newTitle: string): boolean {
    const metaPath = join(this.dir, id, "meta.json");
    if (!existsSync(metaPath)) return false;
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as SessionMeta;
      meta.title = newTitle;
      meta.customTitle = newTitle;
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const tmp = `${metaPath}.${suffix}.tmp`;
      writeFileSync(tmp, JSON.stringify(meta, null, 2), { encoding: "utf-8", mode: 0o600 });
      renameSync(tmp, metaPath);
      return true;
    } catch {
      return false;
    }
  }

  clearAllSessions(): number {
    if (!existsSync(this.dir)) return 0;
    const entries = readdirSync(this.dir);
    let count = 0;
    for (const entry of entries) {
      try {
        const fullPath = join(this.dir, entry);
        rmSync(fullPath, { recursive: true });
        count++;
      } catch {
        // skip
      }
    }
    return count;
  }

  totalSizeBytes(): number {
    if (!existsSync(this.dir)) return 0;
    return this.listSessions().reduce((sum, s) => sum + s.sizeBytes, 0);
  }

  sessionCount(): number {
    if (!existsSync(this.dir)) return 0;
    try {
      return readdirSync(this.dir).filter((e) => {
        try {
          return statSync(join(this.dir, e)).isDirectory();
        } catch {
          return false;
        }
      }).length;
    } catch {
      return 0;
    }
  }

  static deriveTitle(messages: ChatMessage[]): string {
    const first = messages.find((m) => m.role === "user");
    if (!first) return "Empty session";
    const text = first.content.trim();
    if (text.length <= 60) return text;
    return `${text.slice(0, 57)}...`;
  }
}
