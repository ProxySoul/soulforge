export type MemoryScope = "global" | "project";

export interface MemoryScopeConfig {
  writeScope: MemoryScope | "none";
  readScope: MemoryScope | "all" | "none";
}

export type MemoryCategory =
  | "decision"
  | "convention"
  | "preference"
  | "architecture"
  | "pattern"
  | "fact"
  | "checkpoint";

export const MEMORY_CATEGORIES: MemoryCategory[] = [
  "decision",
  "convention",
  "preference",
  "architecture",
  "pattern",
  "fact",
  "checkpoint",
];

export interface MemoryRecord {
  id: string;
  title: string;
  content: string;
  category: MemoryCategory;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface MemorySummary {
  id: string;
  title: string;
  category: MemoryCategory;
  tags: string[];
  updated_at: string;
}

export interface MemoryIndex {
  scope: MemoryScope;
  total: number;
  byCategory: Record<string, number>;
  recent: string[];
}
