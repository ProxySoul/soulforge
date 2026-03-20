import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TEE_DIR = join(homedir(), ".local", "share", "soulforge", "tee");
const MAX_TEE_FILES = 20;

let dirReady = false;

function ensureDir(): void {
  if (dirReady) return;
  mkdirSync(TEE_DIR, { recursive: true });
  dirReady = true;
}

function pruneOldFiles(): void {
  try {
    const files = readdirSync(TEE_DIR)
      .filter((f) => f.endsWith(".txt"))
      .sort();
    const toRemove = files.length - MAX_TEE_FILES;
    if (toRemove > 0) {
      for (const f of files.slice(0, toRemove)) {
        try {
          unlinkSync(join(TEE_DIR, f));
        } catch {}
      }
    }
  } catch {}
}

export function saveTee(label: string, content: string): string {
  ensureDir();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safeName = label.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
  const filename = `${ts}_${safeName}.txt`;
  const filepath = join(TEE_DIR, filename);
  writeFileSync(filepath, content, "utf-8");
  pruneOldFiles();
  return filepath;
}

export function truncateWithTee(
  output: string,
  limit: number,
  headSize: number,
  tailSize: number,
  label: string,
): { text: string; teeFile: string | null } {
  if (output.length <= limit) {
    return { text: output, teeFile: null };
  }
  const teeFile = saveTee(label, output);
  const lineCount = output.split("\n").length;
  const removed = output.length - headSize - tailSize;
  const text = [
    output.slice(0, headSize),
    "",
    `... [${String(removed)} chars / ~${String(lineCount)} lines truncated — full output: ${teeFile}] ...`,
    "",
    output.slice(-tailSize),
  ].join("\n");
  return { text, teeFile };
}
