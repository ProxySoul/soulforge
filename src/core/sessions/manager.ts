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
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { logBackgroundError } from "../../stores/errors.js";
import type { ChatMessage } from "../../types/index.js";
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

  constructor(cwd: string) {
    this.dir = join(cwd, ".soulforge", "sessions");
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  private async dirSize(dirPath: string): Promise<number> {
    let total = 0;
    const entries = await readdir(dirPath);
    for (const f of entries) {
      const fp = join(dirPath, f);
      const s = await stat(fp);
      total += s.isDirectory() ? await this.dirSize(fp) : s.size;
    }
    return total;
  }

  saveSession(meta: SessionMeta, tabMessages: Map<string, ChatMessage[]>): void {
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

    const metaTmp = `${metaPath}.tmp`;
    const jsonlTmp = `${jsonlPath}.tmp`;
    writeFileSync(metaTmp, JSON.stringify(updatedMeta, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    writeFileSync(jsonlTmp, lines ? `${lines}\n` : "", { encoding: "utf-8", mode: 0o600 });
    renameSync(jsonlTmp, jsonlPath);
    renameSync(metaTmp, metaPath);
  }

  loadSession(id: string): { meta: SessionMeta; tabMessages: Map<string, ChatMessage[]> } | null {
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

      return { meta, tabMessages };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logBackgroundError("session-load", `Failed to load session ${id}: ${msg}`);
      return null;
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
    return { messages: msgs, coreMessages: rebuildCoreMessages(msgs) };
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

  async listSessions(): Promise<SessionListEntry[]> {
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
            sizeBytes: await this.dirSize(fullPath),
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

  deleteSession(id: string): boolean {
    const dir = join(this.dir, id);
    if (!existsSync(dir)) return false;
    rmSync(dir, { recursive: true });
    return true;
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

  async totalSizeBytes(): Promise<number> {
    if (!existsSync(this.dir)) return 0;
    return this.dirSize(this.dir);
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
