import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CommandContext } from "./types.js";

export function sysMsg(ctx: CommandContext, content: string): void {
  ctx.chat.setMessages((prev) => [
    ...prev,
    {
      id: crypto.randomUUID(),
      role: "system",
      content,
      timestamp: Date.now(),
    },
  ]);
}

export function fmtTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function dirSize(dirPath: string): number {
  if (!existsSync(dirPath)) return 0;
  let total = 0;
  for (const entry of readdirSync(dirPath)) {
    const fp = join(dirPath, entry);
    try {
      const s = statSync(fp);
      total += s.isDirectory() ? dirSize(fp) : s.size;
    } catch {
      // skip
    }
  }
  return total;
}

export function fileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

export function computeStorageSizes(cwd: string) {
  const home = homedir();
  const projectDir = join(cwd, ".soulforge");
  const globalDir = join(home, ".soulforge");

  const repoMap =
    fileSize(join(projectDir, "repomap.db")) +
    fileSize(join(projectDir, "repomap.db-wal")) +
    fileSize(join(projectDir, "repomap.db-shm"));
  const projectMemory =
    fileSize(join(projectDir, "memory.db")) + fileSize(join(projectDir, "memory.db-wal"));
  const sessions = dirSize(join(projectDir, "sessions"));
  const plans = dirSize(join(projectDir, "plans"));
  const projectConfig =
    fileSize(join(projectDir, "config.json")) + fileSize(join(projectDir, "forbidden.json"));
  const projectTotal = repoMap + projectMemory + sessions + plans + projectConfig;

  const history =
    fileSize(join(globalDir, "history.db")) + fileSize(join(globalDir, "history.db-wal"));
  const globalMemory =
    fileSize(join(globalDir, "memory.db")) + fileSize(join(globalDir, "memory.db-wal"));
  const globalConfig =
    fileSize(join(globalDir, "config.json")) + fileSize(join(globalDir, "secrets.json"));
  const bins = dirSize(join(globalDir, "bin"));
  const fonts = dirSize(join(globalDir, "fonts"));
  const globalTotal = history + globalMemory + globalConfig + bins + fonts;

  return {
    projectDir,
    globalDir,
    repoMap,
    projectMemory,
    sessions,
    plans,
    projectConfig,
    projectTotal,
    history,
    globalMemory,
    globalConfig,
    bins,
    fonts,
    globalTotal,
  };
}
