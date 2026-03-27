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
      userRequirements: [],
      assistantNotes: [],
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

  setTask(task: string): void {
    this.state.task = task;
  }

  setPlan(
    steps: { id: string; label: string; status: "pending" | "active" | "done" | "skipped" }[],
  ): void {
    this.state.plan = steps;
  }

  updatePlanStep(stepId: string, status: "pending" | "active" | "done" | "skipped"): void {
    const step = this.state.plan.find((s) => s.id === stepId);
    if (step) step.status = status;
  }

  trackFile(path: string, action: FileAction): void {
    const existing = this.state.files.get(path);
    if (existing) {
      existing.actions.push(action);
    } else {
      this.state.files.set(path, { path, actions: [action] });
    }
  }

  addUserRequirement(text: string): void {
    if (text.length < 5) return;
    this.state.userRequirements.push(text);
    if (this.state.userRequirements.length > WorkingStateManager.MAX_LIST_SIZE) {
      this.state.userRequirements.shift();
    }
  }

  addAssistantNote(text: string): void {
    if (text.length < 10) return;
    this.state.assistantNotes.push(text);
    if (this.state.assistantNotes.length > WorkingStateManager.MAX_LIST_SIZE) {
      this.state.assistantNotes.shift();
    }
  }

  private static readonly MAX_LIST_SIZE = 25;

  private addUnique(list: string[], item: string): void {
    if (!list.includes(item)) {
      list.push(item);
      if (list.length > WorkingStateManager.MAX_LIST_SIZE) list.shift();
    }
  }

  private addCapped(list: string[], item: string): void {
    list.push(item);
    if (list.length > WorkingStateManager.MAX_LIST_SIZE) list.shift();
  }

  addDecision(d: string): void {
    this.addUnique(this.state.decisions, d);
  }

  addFailure(f: string): void {
    this.addCapped(this.state.failures, f);
  }

  addDiscovery(d: string): void {
    this.addUnique(this.state.discoveries, d);
  }

  addEnvironment(e: string): void {
    if (!this.state.environment.includes(e)) {
      this.state.environment.push(e);
    }
  }

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
      s.environment.length +
      s.userRequirements.length +
      s.assistantNotes.length
    );
  }

  serialize(): string {
    return serializeState(this.state);
  }
}

export function serializeState(s: WorkingState): string {
  const sections: string[] = [];

  if (s.task) {
    sections.push(`## Task\n${s.task}`);
  }

  if (s.userRequirements.length > 0) {
    sections.push(`## User Requirements\n${s.userRequirements.map((r) => `- ${r}`).join("\n")}`);
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

  if (s.assistantNotes.length > 0) {
    sections.push(`## Assistant Notes\n${s.assistantNotes.map((n) => `- ${n}`).join("\n")}`);
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
