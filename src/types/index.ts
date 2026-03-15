// ─── LLM Types ───

export interface RouterRule {
  /** glob pattern or keyword to match against the user message */
  match?: string;
  /** model ID in "provider/model" format */
  modelId: string;
  /** priority — higher wins when multiple rules match */
  priority?: number;
}

export interface TaskRouter {
  planning: string | null;
  coding: string | null;
  exploration: string | null;
  webSearch: string | null;
  compact: string | null;
  semantic: string | null;
  /** Lightweight model for trivial dispatch tasks (single-file reads, small edits) */
  trivial: string | null;
  /** Model for de-sloppify cleanup pass after code agents */
  desloppify: string | null;
  default: string | null;
}

// ─── Tool Types ───

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  /** Which intelligence backend handled this (ts-morph, lsp, tree-sitter, regex) */
  backend?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<ToolResult>;
}

// ─── Plan / Interactive Types ───

export type PlanStepStatus = "pending" | "active" | "done" | "skipped";

export interface PlanStep {
  id: string;
  label: string;
  status: PlanStepStatus;
  startedAt?: number;
}

export type PlanDepth = "light" | "full";

export interface Plan {
  title: string;
  steps: PlanStep[];
  createdAt: number;
  depth: PlanDepth;
}

export interface PlanSymbolChange {
  name: string;
  kind: string;
  action: "add" | "modify" | "remove" | "rename";
  details: string;
  line?: number;
}

export interface PlanFileChange {
  path: string;
  action: "create" | "modify" | "delete";
  description: string;
  symbols?: PlanSymbolChange[];
}

export interface PlanOutput {
  title: string;
  context: string;
  files: PlanFileChange[];
  steps: Array<{ id: string; label: string; details?: string }>;
  verification: string[];
}

export interface QuestionOption {
  label: string;
  value: string;
  description?: string;
}

export interface PendingQuestion {
  id: string;
  question: string;
  options: QuestionOption[];
  allowSkip: boolean;
  resolve: (answer: string) => void;
}

export type PlanReviewAction = "execute" | "clear_execute" | "cancel" | string;

export interface PendingPlanReview {
  plan: Plan;
  planFile: string;
  planContent: string;
  resolve: (action: PlanReviewAction) => void;
}

export interface InteractiveCallbacks {
  onPlanCreate: (plan: Plan) => void;
  onPlanStepUpdate: (stepId: string, status: PlanStepStatus) => void;
  onPlanReview: (plan: Plan, planFile: string, planContent: string) => Promise<PlanReviewAction>;
  onAskUser: (question: string, options: QuestionOption[], allowSkip: boolean) => Promise<string>;
  onOpenEditor: (file?: string) => Promise<void>;
  onWebSearchApproval: (query: string) => Promise<boolean>;
  onFetchPageApproval: (url: string) => Promise<boolean>;
}

export interface QueuedMessage {
  content: string;
  queuedAt: number;
}

// ─── Chat / Session Types ───

export type MessageSegment =
  | { type: "text"; content: string }
  | { type: "tools"; toolCallIds: string[] }
  | { type: "reasoning"; content: string; id: string }
  | { type: "plan"; plan: Plan };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  /** Ordered segments for interleaved text/tool rendering. */
  segments?: MessageSegment[];
  /** When true, system messages render inline in chat instead of the ephemeral banner. */
  showInChat?: boolean;
  /** Marks a user message injected via steering (sent while AI was working). */
  isSteering?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: ToolResult;
}

// ─── Config Types ───

export type NvimConfigMode = "default" | "user" | "none";

export interface CodeIntelligenceConfig {
  backend?: "auto" | "ts-morph" | "tree-sitter" | "regex";
  language?: string;
}

// ─── AI Provider Config Types ───

export type ThinkingMode = "off" | "adaptive" | "enabled" | "disabled" | "auto";

export interface ThinkingConfig {
  /** "auto" enables adaptive thinking for Anthropic models. Default: "auto" */
  mode: ThinkingMode;
  /** Budget tokens — only used when mode is "enabled". Min 1024. */
  budgetTokens?: number;
}

export type EffortLevel = "low" | "medium" | "high" | "max";

export type OpenAIReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ServiceTier = "auto" | "flex" | "priority" | "default";

export interface PerformanceConfig {
  /** Effort level for model reasoning. "off" = not sent to API. */
  effort?: EffortLevel | "off";
  /** Speed mode — "fast" enables 2.5x output for Opus 4.6. "off" = not sent to API. */
  speed?: "off" | "fast" | "standard";
  /** Disable parallel tool calls — model calls one tool at a time. */
  disableParallelToolUse?: boolean;
  /** Send reasoning content in requests. Default: true. */
  sendReasoning?: boolean;
  /** OpenAI reasoning effort for o3/o4/gpt-5 models. "off" = not sent. */
  openaiReasoningEffort?: OpenAIReasoningEffort | "off";
  /** OpenAI service tier — "flex" saves 50% with latency trade-off. */
  serviceTier?: ServiceTier | "off";
}

export interface ContextManagementConfig {
  /** Enable server-side context compaction for 200K+ models */
  compact?: boolean;
  /** Clear old tool use results (keep last 10) */
  clearToolUses?: boolean;
  /** Clear old thinking blocks (keep last 5 turns) */
  clearThinking?: boolean;
}

export interface CompactionConfig {
  /** "v1" = LLM batch summarization (default), "v2" = incremental structured extraction */
  strategy?: "v1" | "v2";
  /** Threshold (0-1) at which auto-compaction triggers. Default: 0.7 */
  triggerThreshold?: number;
  /** Hysteresis reset threshold. Default: 0.4 */
  resetThreshold?: number;
  /** Number of recent messages to keep verbatim. Default: 4 */
  keepRecent?: number;
  /** Max tool result slots to retain in working state (v2 only). Default: 30 */
  maxToolResults?: number;
  /** Use a cheap LLM gap-fill pass for fuzzy extraction (v2 only). Default: true */
  llmExtraction?: boolean;
}

export interface AgentFeatures {
  /** Run a cleanup agent after code agents to remove sloppy patterns. Default: true (when desloppify model is set in /router) */
  desloppify?: boolean;
  /** Auto-classify tasks as trivial and route to cheaper models. Default: true (when trivial model is set in /router) */
  tierRouting?: boolean;
  /** Cache file reads across dispatch boundaries so parent doesn't re-read. Default: true */
  dispatchCache?: boolean;
  /** Require targetFiles on dispatch tasks — reject vague instructions. Default: true */
  targetFileValidation?: boolean;
}

export interface AppConfig {
  defaultModel: string;
  routerRules: RouterRule[];
  taskRouter?: TaskRouter;
  editor: {
    command: string; // "nvim" by default
    args: string[];
  };
  theme: {
    accentColor: string;
  };
  nvimPath?: string;
  nvimConfig?: NvimConfigMode;
  editorIntegration?: EditorIntegration;
  codeIntelligence?: CodeIntelligenceConfig;
  font?: string;
  thinking?: ThinkingConfig;
  performance?: PerformanceConfig;
  contextManagement?: ContextManagementConfig;
  compaction?: CompactionConfig;
  codeExecution?: boolean;
  /** Enable web search tool for all LLMs. Always prompts for approval before searching. Default: true */
  webSearch?: boolean;
  /** Show vim keybinding hints in the editor panel. Default: true */
  vimHints?: boolean;
  /** Editor/chat split percentage (editor width). Default: 60 */
  editorSplit?: number;
  /** Show verbose tool output (plan updates, etc.) in chat. Default: false */
  verbose?: boolean;
  /** Diff display style: "default" | "sidebyside" | "compact". Default: "default" */
  diffStyle?: "default" | "sidebyside" | "compact";
  /** Whether the terminal uses a Nerd Font. null = auto-detect from installed fonts. */
  nerdFont?: boolean | null;
  /** Chat layout style. Default: "accent" */
  chatStyle?: ChatStyle;
  /** Show reasoning/thinking content in chat. Default: true */
  showReasoning?: boolean;
  /** Add co-author trailer on AI-assisted commits. Default: true */
  coAuthorCommits?: boolean;
  /** Default forge mode for new sessions. Default: "default" */
  defaultForgeMode?: ForgeMode;
  /** Enable AST-based repo map in system prompt instead of file tree. Default: true */
  repoMap?: boolean;
  /** Semantic summary mode: "off" (default), "ast" (extract docstrings), "llm" (AI-generated). Boolean for backward compat: true → "llm", false → "off". */
  semanticSummaries?: "off" | "ast" | "llm" | boolean;
  /** LSP servers to disable (by Mason package name). Scoped: project overrides global. */
  disabledLspServers?: string[];
  agentFeatures?: AgentFeatures;
}

// ─── Focus Types ───

export type FocusMode = "chat" | "editor";

// ─── Forge Mode Types ───

export type ForgeMode = "default" | "architect" | "socratic" | "challenge" | "plan";

// ─── Editor Types ───

export type ChatStyle = "accent" | "bubble";

export type EditorMode = "chat" | "editor" | "split";

export interface EditorState {
  mode: EditorMode;
  currentFile: string | null;
  cursorLine: number;
  cursorCol: number;
  modified: boolean;
}

export interface EditorIntegration {
  diagnostics: boolean;
  symbols: boolean;
  hover: boolean;
  references: boolean;
  definition: boolean;
  codeActions: boolean;
  editorContext: boolean;
  rename: boolean;
  lspStatus: boolean;
  format: boolean;
}
