import type { CompactionConfig, FileAction, WorkingState } from "./types.js";
import { DEFAULT_COMPACTION_CONFIG } from "./types.js";

export class WorkingStateManager {
  private state: WorkingState;
  private config: CompactionConfig;

  constructor(config?: Partial<CompactionConfig>) {
    this.config = { ...DEFAULT_COMPACTION_CONFIG, ...config };
    this.state = this.createEmpty();
  }

  private createEmpty(): WorkingState {
    return {
      task: "",
      plan: [],
      files: new Map(),
      decisions: [],
      failures: [],
      discoveries: [],
      environment: [],
      toolResults: [],
    };
  }

  getState(): Readonly<WorkingState> {
    return this.state;
  }

  getConfig(): Readonly<CompactionConfig> {
    return this.config;
  }

  reset(): void {
    this.state = this.createEmpty();
  }

  // ─── Task ───

  setTask(task: string): void {
    this.state.task = task;
  }

  // ─── Plan ───

  setPlan(
    steps: { id: string; label: string; status: "pending" | "active" | "done" | "skipped" }[],
  ): void {
    this.state.plan = steps;
  }

  updatePlanStep(stepId: string, status: "pending" | "active" | "done" | "skipped"): void {
    const step = this.state.plan.find((s) => s.id === stepId);
    if (step) step.status = status;
  }

  // ─── Files ───

  trackFile(path: string, action: FileAction): void {
    const existing = this.state.files.get(path);
    if (existing) {
      existing.actions.push(action);
    } else {
      this.state.files.set(path, { path, actions: [action] });
    }
  }

  // ─── Decisions / Failures / Discoveries ───

  addDecision(d: string): void {
    if (!this.state.decisions.includes(d)) {
      this.state.decisions.push(d);
    }
  }

  addFailure(f: string): void {
    this.state.failures.push(f);
  }

  addDiscovery(d: string): void {
    if (!this.state.discoveries.includes(d)) {
      this.state.discoveries.push(d);
    }
  }

  // ─── Environment ───

  addEnvironment(e: string): void {
    if (!this.state.environment.includes(e)) {
      this.state.environment.push(e);
    }
  }

  // ─── Tool Results ───

  addToolResult(tool: string, summary: string): void {
    const maxResults = this.config.maxToolResults ?? 30;
    this.state.toolResults.push({ tool, summary, timestamp: Date.now() });
    if (this.state.toolResults.length > maxResults) {
      this.state.toolResults = this.state.toolResults.slice(-maxResults);
    }
  }

  slotCount(): number {
    const s = this.state;
    return (
      (s.task ? 1 : 0) +
      s.files.size +
      s.decisions.length +
      s.failures.length +
      s.discoveries.length +
      s.toolResults.length +
      s.environment.length
    );
  }

  // ─── Serialization ───

  serialize(): string {
    const s = this.state;
    const sections: string[] = [];

    if (s.task) {
      sections.push(`## Task\n${s.task}`);
    }

    if (s.plan.length > 0) {
      const planLines = s.plan.map((step) => {
        const icon =
          step.status === "done"
            ? "✓"
            : step.status === "active"
              ? "▸"
              : step.status === "skipped"
                ? "⊘"
                : "○";
        return `  ${icon} [${step.id}] ${step.label} — ${step.status}`;
      });
      sections.push(`## Plan\n${planLines.join("\n")}`);
    }

    if (s.environment.length > 0) {
      sections.push(`## Environment\n${s.environment.map((e) => `- ${e}`).join("\n")}`);
    }

    if (s.files.size > 0) {
      const fileLines: string[] = [];
      for (const [path, slot] of s.files) {
        const actions = slot.actions.map((a) => {
          if (a.type === "read") return `read: ${a.summary}`;
          if (a.type === "edit") return `edited: ${a.detail}`;
          if (a.type === "create") return `created: ${a.detail}`;
          return "deleted";
        });
        fileLines.push(`- \`${path}\`: ${actions.join("; ")}`);
      }
      sections.push(`## Files Touched\n${fileLines.join("\n")}`);
    }

    if (s.decisions.length > 0) {
      sections.push(`## Key Decisions\n${s.decisions.map((d) => `- ${d}`).join("\n")}`);
    }

    if (s.toolResults.length > 0) {
      const resultLines = s.toolResults.map((r) => `- **${r.tool}**: ${r.summary}`);
      sections.push(`## Tool Results\n${resultLines.join("\n")}`);
    }

    if (s.failures.length > 0) {
      sections.push(`## Errors & Failures\n${s.failures.map((f) => `- ${f}`).join("\n")}`);
    }

    if (s.discoveries.length > 0) {
      sections.push(`## Discoveries\n${s.discoveries.map((d) => `- ${d}`).join("\n")}`);
    }

    return sections.join("\n\n");
  }
}
