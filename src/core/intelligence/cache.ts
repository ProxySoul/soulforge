import { readFileSync, statSync } from "node:fs";

interface CacheEntry {
  content: string;
  mtime: number;
}

/**
 * File content cache keyed by absolute path, invalidated by mtime.
 * Avoids re-reading files that haven't changed.
 */
export class FileCache {
  private entries = new Map<string, CacheEntry>();
  private maxSize: number;

  constructor(maxSize = 200) {
    this.maxSize = maxSize;
  }

  /** Get file content, re-reading only if mtime changed */
  get(filePath: string): string | null {
    try {
      const stat = statSync(filePath);
      const mtime = stat.mtimeMs;
      const cached = this.entries.get(filePath);

      if (cached && cached.mtime === mtime) {
        return cached.content;
      }

      const content = readFileSync(filePath, "utf-8");
      this.set(filePath, content, mtime);
      return content;
    } catch {
      return null;
    }
  }

  /** Manually set a cache entry */
  set(filePath: string, content: string, mtime?: number): void {
    if (this.entries.size >= this.maxSize) {
      // Evict oldest entry
      const firstKey = this.entries.keys().next().value;
      if (firstKey) this.entries.delete(firstKey);
    }
    const mt = mtime ?? Date.now();
    this.entries.set(filePath, { content, mtime: mt });
  }

  /** Invalidate a specific file */
  invalidate(filePath: string): void {
    this.entries.delete(filePath);
  }

  /** Clear entire cache */
  clear(): void {
    this.entries.clear();
  }
}
