import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorkerHandler } from "./rpc.js";

const handlers: Record<string, (...args: unknown[]) => unknown> = {
  // ── Shell Output Compression ───────────────────────────────────────
  compressShellOutput: async (raw: unknown) => {
    const { compressShellOutput } = await import("../tools/shell-compress.js");
    return compressShellOutput(raw as string);
  },

  compressShellOutputFull: async (raw: unknown) => {
    const { compressShellOutputFull } = await import("../tools/shell-compress.js");
    return compressShellOutputFull(raw as string);
  },

  // ── File Tree ──────────────────────────────────────────────────────
  walkDir: async (dir: unknown, prefix: unknown, depth: unknown) => {
    const { walkDir } = await import("../context/file-tree.js");
    const lines: string[] = [];
    walkDir(dir as string, prefix as string, depth as number, lines);
    return lines;
  },

  // ── Git Parsing ────────────────────────────────────────────────────
  parseGitLogLine: async (line: unknown) => {
    const { parseGitLogLine } = await import("../git/status.js");
    return parseGitLogLine(line as string);
  },

  parseGitLogBatch: async (lines: unknown) => {
    const { parseGitLogLine } = await import("../git/status.js");
    return (lines as string[]).map(parseGitLogLine);
  },

  // ── Compaction Serialization ───────────────────────────────────────
  serializeWorkingState: async (state: unknown) => {
    const { serializeState } = await import("../compaction/working-state.js");
    const s = state as import("../compaction/types.js").WorkingState;
    return serializeState(s);
  },

  buildConvoText: async (messages: unknown, charBudget: unknown) => {
    const { buildFullConvoText } = await import("../compaction/summarize.js");
    type ModelMessage = import("ai").ModelMessage;
    return buildFullConvoText(messages as ModelMessage[], charBudget as number);
  },

  // ── Session Persistence ────────────────────────────────────────────
  saveSession: async (sessionDir: unknown, meta: unknown, tabEntries: unknown) => {
    const dir = sessionDir as string;
    const sessionMeta = meta as import("../sessions/types.js").SessionMeta;
    const entries = tabEntries as [string, unknown[]][];

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const allMessages: unknown[] = [];
    const updatedTabs = sessionMeta.tabs.map((tab) => {
      const msgs = entries.find(([id]) => id === tab.id)?.[1] ?? [];
      const startLine = allMessages.length;
      for (const msg of msgs) allMessages.push(msg);
      const endLine = allMessages.length;
      return { ...tab, messageRange: { startLine, endLine } };
    });

    const updatedMeta = { ...sessionMeta, tabs: updatedTabs };
    const metaJson = JSON.stringify(updatedMeta, null, 2);
    const lines = allMessages.map((m) => JSON.stringify(m)).join("\n");

    const metaPath = join(dir, "meta.json");
    const jsonlPath = join(dir, "messages.jsonl");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const metaTmp = `${metaPath}.${suffix}.tmp`;
    const jsonlTmp = `${jsonlPath}.${suffix}.tmp`;

    await writeFile(metaTmp, metaJson, { encoding: "utf-8", mode: 0o600 });
    await writeFile(jsonlTmp, lines ? `${lines}\n` : "", { encoding: "utf-8", mode: 0o600 });
    await rename(jsonlTmp, jsonlPath);
    await rename(metaTmp, metaPath);
  },

  loadSession: async (sessionDir: unknown) => {
    const dir = sessionDir as string;
    const metaPath = join(dir, "meta.json");
    if (!existsSync(metaPath)) return null;

    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    const jsonlPath = join(dir, "messages.jsonl");
    const allMessages: unknown[] = [];

    if (existsSync(jsonlPath)) {
      const content = readFileSync(jsonlPath, "utf-8").trim();
      if (content) {
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          try {
            allMessages.push(JSON.parse(line));
          } catch {
            break;
          }
        }
      }
    }

    const tabEntries: [string, unknown[]][] = [];
    for (const tab of meta.tabs) {
      const { startLine, endLine } = tab.messageRange;
      tabEntries.push([tab.id, allMessages.slice(startLine, endLine)]);
    }

    return { meta, tabEntries };
  },
};

createWorkerHandler(handlers);
