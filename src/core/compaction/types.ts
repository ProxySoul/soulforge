export interface WorkingState {
  task: string;
  plan: PlanSlot[];
  files: Map<string, FileSlot>;
  decisions: string[];
  failures: string[];
  discoveries: string[];
  environment: string[];
  toolResults: ToolResultSlot[];
}

export interface PlanSlot {
  id: string;
  label: string;
  status: "pending" | "active" | "done" | "skipped";
}

export interface FileSlot {
  path: string;
  actions: FileAction[];
}

export type FileAction =
  | { type: "read"; summary: string }
  | { type: "edit"; detail: string }
  | { type: "create"; detail: string }
  | { type: "delete" };

export interface ToolResultSlot {
  tool: string;
  summary: string;
  timestamp: number;
}

export interface CompactionConfig {
  strategy: "v1" | "v2";
  /** Threshold (0-1) at which auto-compaction triggers. Default: 0.7 */
  triggerThreshold?: number;
  /** Hysteresis reset threshold. Default: 0.4 */
  resetThreshold?: number;
  /** Number of recent messages to keep verbatim. Default: 4 */
  keepRecent?: number;
  /** Max tool result slots to retain in working state. Default: 30 */
  maxToolResults?: number;
  /** Use a cheap LLM pass for fuzzy extraction (decisions from AI text). Default: true */
  llmExtraction?: boolean;
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  strategy: "v1",
  triggerThreshold: 0.7,
  resetThreshold: 0.4,
  keepRecent: 4,
  maxToolResults: 30,
  llmExtraction: true,
};
