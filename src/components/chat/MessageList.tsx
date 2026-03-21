import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TextAttributes } from "@opentui/core";
import { memo, type ReactNode, useEffect, useMemo, useState } from "react";
import { icon } from "../../core/icons.js";
import {
  CATEGORY_COLORS,
  resolveToolDisplay,
  TOOL_ICONS,
  TOOL_LABELS,
  type ToolCategory,
} from "../../core/tool-display.js";
import { useUIStore } from "../../stores/ui.js";
import type {
  ChatMessage,
  ChatStyle,
  MessageSegment,
  PlanOutput,
  ToolCall,
} from "../../types/index.js";
import { StructuredPlanView } from "../plan/StructuredPlanView.js";
import { DiffView } from "./DiffView.js";
import { Markdown, useCodeExpanded } from "./Markdown.js";
import { ReasoningBlock } from "./ReasoningBlock.js";

const REVEAL_INTERVAL = 30;
const MAX_REVEAL_STEPS = 15;
const CURSOR_CHAR = "\u2588"; // █
const USER_COLOR = "#00BFFF";
const ASSISTANT_COLOR = "#9B30FF";
const SYSTEM_COLOR = "#555";
const ERROR_COLOR = "#f44";
export const RAIL_BORDER = {
  topLeft: "▌",
  topRight: "▌",
  bottomLeft: "▌",
  bottomRight: "▌",
  horizontal: "▌",
  vertical: "▌",
  topT: "▌",
  bottomT: "▌",
  leftT: "▌",
  rightT: "▌",
  cross: "▌",
};
interface Props {
  messages: ChatMessage[];
  chatStyle: ChatStyle;
  diffStyle?: "default" | "sidebyside" | "compact";
  showReasoning?: boolean;
  reasoningExpanded?: boolean;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", {
    hour12: true,
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatToolSummary(tc: ToolCall): string {
  if (tc.name === "read_file" && typeof tc.args.path === "string") return String(tc.args.path);
  if (tc.name === "edit_file" && typeof tc.args.path === "string") return String(tc.args.path);
  if (tc.name === "shell" && typeof tc.args.command === "string") {
    const cmd = String(tc.args.command);
    return cmd.length > 60 ? `${cmd.slice(0, 57)}...` : cmd;
  }
  if (tc.name === "grep" && typeof tc.args.pattern === "string")
    return `/${String(tc.args.pattern)}/`;
  if (tc.name === "glob" && typeof tc.args.pattern === "string") return String(tc.args.pattern);
  if (tc.name === "web_search" && typeof tc.args.query === "string") {
    const q = String(tc.args.query);
    return q.length > 50 ? `${q.slice(0, 47)}...` : q;
  }
  return "";
}

const RETRY_COLOR = "#fa0";

function cleanErrorDetail(msg: string): string {
  let cleaned = msg.replace(/\[([^\]]+)\]\([^)]+\)/g, "");
  cleaned = cleaned.replace(/https?:\/\/\S+/g, "");
  cleaned = cleaned.replace(/For details,?\s*refer to:?\s*/gi, "");
  cleaned = cleaned.replace(/You can see the response headers[^.]*\.\s*/g, "");
  cleaned = cleaned.replace(/You may also contact sales[^.]*\.\s*/g, "");
  cleaned = cleaned.replace(/\s{2,}/g, " ").trim();
  cleaned = cleaned.replace(/[\s.]+$/, "");
  return cleaned;
}

function categorizeError(msg: string): { category: string; detail: string } {
  const raw = msg
    .replace(/^Error:\s*/, "")
    .replace(/^Request failed:\s*/, "")
    .replace(/^Failed[^:]*:\s*/, "");
  if (/rate.?limit|too many requests|429|529/i.test(raw))
    return { category: "Rate Limited", detail: cleanErrorDetail(raw) };
  if (/overloaded|503|capacity/i.test(raw))
    return { category: "Service Overloaded", detail: cleanErrorDetail(raw) };
  if (/unauthorized|401|403|api.?key|invalid.*key/i.test(raw))
    return { category: "Auth Error", detail: cleanErrorDetail(raw) };
  if (/not permitted|not supported|invalid parameter|unknown parameter/i.test(raw))
    return { category: "Config Error", detail: cleanErrorDetail(raw) };
  if (/network|ECONNREFUSED|ETIMEDOUT|fetch failed|502/i.test(raw))
    return { category: "Network Error", detail: cleanErrorDetail(raw) };
  return { category: "Error", detail: cleanErrorDetail(raw) };
}

function parseRetry(text: string): { attempt: string; reason: string; delay: string } | null {
  const match = text.match(/^Retry (\d+\/\d+): (.+?) \[delay:(\d+)s\]$/);
  if (!match) return null;
  return { attempt: match[1] as string, reason: match[2] as string, delay: match[3] as string };
}

function SystemMessage({ msg, animate = true }: { msg: ChatMessage; animate?: boolean }) {
  const time = formatTime(msg.timestamp);
  const text = msg.content;
  const isError =
    text.startsWith("Error:") || text.startsWith("Request failed:") || text.startsWith("Failed");
  const retry = parseRetry(text);
  const isInterrupt = text === "Generation interrupted.";

  const displayText = isError
    ? categorizeError(text).detail
    : retry
      ? `${categorizeError(retry.reason).category.toLowerCase()} — waiting ~${retry.delay}s`
      : text;

  const railColor = isError ? ERROR_COLOR : retry ? RETRY_COLOR : SYSTEM_COLOR;
  const textColor = isError ? "#e88" : retry ? "#777" : "#777";

  const chunkSize = Math.max(1, Math.ceil(displayText.length / MAX_REVEAL_STEPS));
  const totalSteps = Math.ceil(displayText.length / chunkSize);
  const [step, setStep] = useState(animate ? 0 : totalSteps);
  const [done, setDone] = useState(!animate);

  useEffect(() => {
    if (done) return;
    if (step >= totalSteps) {
      setDone(true);
      return;
    }
    const timer = setTimeout(() => setStep((s) => s + 1), REVEAL_INTERVAL);
    return () => clearTimeout(timer);
  }, [step, totalSteps, done]);

  const visibleText = done ? displayText : displayText.slice(0, step * chunkSize);
  const lines = visibleText.split("\n");

  const headerLabel = isError
    ? categorizeError(text).category
    : retry
      ? `Retry ${retry.attempt}`
      : isInterrupt
        ? "Interrupted"
        : "System";
  const headerIcon = isError ? "✗" : retry ? "↻" : isInterrupt ? "⊘" : "›";

  return (
    <box
      flexDirection="column"
      marginBottom={1}
      border={["left"]}
      borderColor={railColor}
      customBorderChars={RAIL_BORDER}
      paddingLeft={2}
      paddingRight={1}
      paddingY={1}
    >
      <box flexDirection="row">
        {isError ? (
          <text fg={ERROR_COLOR} attributes={TextAttributes.BOLD}>
            {headerIcon} {headerLabel}
          </text>
        ) : retry ? (
          <text fg="#da0" attributes={TextAttributes.BOLD}>
            {headerIcon} {headerLabel}
          </text>
        ) : (
          <text fg={SYSTEM_COLOR}>
            {headerIcon ? `${headerIcon} ` : ""}
            {headerLabel}
          </text>
        )}
        <text fg="#333"> · {time}</text>
      </box>
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stable line order
        <text key={i} fg={textColor}>
          {line}
        </text>
      ))}
      {!done && <text fg={railColor}>{CURSOR_CHAR}</text>}
    </box>
  );
}

const META_TOOLS = new Set(["plan", "update_plan_step", "ask_user", "editor_panel"]);
const EDIT_NAMES = new Set(["edit_file", "multi_edit"]);

function isFailedEditCall(tc: ToolCall): boolean {
  return EDIT_NAMES.has(tc.name) && !!tc.result && !tc.result.success;
}

function extractPathFromArgs(args?: Record<string, unknown>): string | null {
  if (!args || typeof args.path !== "string") return null;
  return args.path;
}

function parseBackend(result?: { output: string }): string | null {
  if (!result) return null;
  try {
    const parsed = JSON.parse(result.output);
    if (parsed.backend && typeof parsed.backend === "string") return parsed.backend as string;
  } catch {}
  return null;
}

function isDenied(error?: string): boolean {
  return !!error && /denied|rejected|cancelled/i.test(error);
}

function cleanErrorForDisplay(error: string): string {
  let clean = error.replace(/Available tools:\s*[\w,\s]+\.?/i, "").trim();
  clean = clean.replace(/Value:\s*\{[^}]+\}\.?/i, "").trim();
  clean = clean.replace(/\s{2,}/g, " ");
  return clean || error;
}

function ToolCallRow({ tc }: { tc: ToolCall }) {
  const errorsExpanded = useUIStore((s) => s.reasoningExpanded);
  const { icon, iconColor, label, category: staticCategory } = resolveToolDisplay(tc.name);
  const backend = parseBackend(tc.result);
  const category = backend ?? staticCategory;
  const categoryColor = category ? (CATEGORY_COLORS[category as ToolCategory] ?? "#444") : "#444";
  const argStr = formatToolSummary(tc);
  const denied = !tc.result?.success && isDenied(tc.result?.error);
  const isError = !!tc.result && !tc.result.success && !denied;
  const statusIcon = tc.result ? (tc.result.success ? "✓" : denied ? "⊘" : "✗") : "●";
  const statusColor = tc.result ? (tc.result.success ? "#4a7" : denied ? "#666" : "#f44") : "#666";
  const shortResult = tc.result
    ? tc.result.success
      ? "ok"
      : denied
        ? "denied"
        : "failed"
    : "pending";
  const fullError = tc.result?.error ?? "";

  if (isError && errorsExpanded && fullError.length > 0) {
    return (
      <box flexDirection="column" flexShrink={0}>
        <box height={1} flexShrink={0}>
          <text truncate>
            <span fg={statusColor}>{statusIcon} </span>
            <span fg={iconColor}>{icon} </span>
            {category ? <span fg={categoryColor}>[{category}] </span> : null}
            <span fg="#999">{label}</span>
            {argStr ? <span fg="#777"> {argStr}</span> : null}
            <span fg="#555"> → </span>
            <span fg={statusColor}>{shortResult}</span>
          </text>
        </box>
        <box paddingLeft={3} flexShrink={0}>
          <text fg="#a55">{fullError}</text>
        </box>
      </box>
    );
  }

  const displayResult = isError ? cleanErrorForDisplay(fullError) : shortResult;
  const previewLen = 60;
  const preview =
    isError && displayResult.length > previewLen
      ? `${displayResult.slice(0, previewLen - 3)}…`
      : displayResult;

  return (
    <box height={1} flexShrink={0}>
      <text truncate>
        <span fg={statusColor}>{statusIcon} </span>
        <span fg={iconColor}>{icon} </span>
        {category ? <span fg={categoryColor}>[{category}] </span> : null}
        <span fg="#999">{label}</span>
        {argStr ? <span fg="#777"> {argStr}</span> : null}
        <span fg="#555"> → </span>
        <span fg={isError ? "#a55" : statusColor}>{preview}</span>
        {isError ? <span fg="#333"> ^T</span> : null}
      </text>
    </box>
  );
}

function CollapsedToolGroup({ calls }: { calls: ToolCall[] }) {
  const count = calls.length;
  const allOk = calls.every((tc) => tc.result?.success);
  return (
    <box height={1} flexShrink={0}>
      <text truncate>
        <span fg={allOk ? "#4a7" : "#f44"}>{allOk ? "✓" : "✗"} </span>
        <span fg="#777">
          {String(count)} tool call{count > 1 ? "s" : ""} (
          {calls.map((tc) => TOOL_LABELS[tc.name] ?? tc.name).join(", ")})
        </span>
      </text>
    </box>
  );
}

function EditToolCall({
  tc,
  diffStyle,
}: {
  tc: ToolCall;
  diffStyle?: "default" | "sidebyside" | "compact";
}) {
  const expanded = useCodeExpanded();
  const hasDiff =
    typeof tc.args.path === "string" &&
    typeof tc.args.oldString === "string" &&
    typeof tc.args.newString === "string";

  if (!hasDiff) return <ToolCallRow tc={tc} />;

  // Collapsed by default — Ctrl+O toggles expanded
  const mode = expanded ? diffStyle : "compact";

  return (
    <DiffView
      filePath={tc.args.path as string}
      oldString={tc.args.oldString as string}
      newString={tc.args.newString as string}
      success={tc.result?.success ?? false}
      errorMessage={tc.result?.error}
      mode={mode}
    />
  );
}

function parsePlanFromArgs(tc: ToolCall): PlanOutput | null {
  if (tc.name !== "write_plan" && tc.name !== "plan") return null;
  const a = tc.args;
  if (typeof a.title === "string" && Array.isArray(a.files) && Array.isArray(a.steps)) {
    return a as unknown as PlanOutput;
  }
  return null;
}

function parsePlanResult(tc: ToolCall): { file?: string; resultStr?: string } {
  if (!tc.result?.output) return {};
  try {
    const parsed = JSON.parse(tc.result.output);
    return {
      file: typeof parsed.file === "string" ? (parsed.file as string) : undefined,
      resultStr: typeof parsed.output === "string" ? (parsed.output as string) : tc.result.output,
    };
  } catch {
    return { resultStr: tc.result.output };
  }
}

function WritePlanCall({ tc }: { tc: ToolCall }) {
  const plan = parsePlanFromArgs(tc);
  const { file: planFile, resultStr } = parsePlanResult(tc);
  const markdown = useMemo(() => {
    if (!planFile) return null;
    try {
      return readFileSync(join(process.cwd(), planFile), "utf-8");
    } catch {
      return null;
    }
  }, [planFile]);
  if (!plan) return <ToolCallRow tc={tc} />;
  return (
    <>
      <StructuredPlanView plan={plan} result={resultStr} planFile={planFile} />
      {markdown && !resultStr?.includes("cancelled") && (
        <box
          flexDirection="column"
          flexShrink={0}
          border
          borderStyle="rounded"
          borderColor="#333"
          marginTop={1}
          paddingX={1}
        >
          <Markdown text={markdown} />
        </box>
      )}
    </>
  );
}

const TRUNCATE_THRESHOLD = 10;
const TRUNCATE_HEAD = 4;
const TRUNCATE_TAIL = 4;

function truncateUserContent(content: string, expanded: boolean): ReactNode {
  const lines = content.split("\n");
  if (expanded || lines.length <= TRUNCATE_THRESHOLD) {
    return <text>{content}</text>;
  }
  const head = lines.slice(0, TRUNCATE_HEAD).join("\n");
  const tail = lines.slice(-TRUNCATE_TAIL).join("\n");
  const hidden = lines.length - TRUNCATE_HEAD - TRUNCATE_TAIL;
  return (
    <box flexDirection="column">
      <text>{head}</text>
      <text fg="#555">
        {"// <+"}
        {String(hidden)}
        {" lines> //"}
      </text>
      <text>{tail}</text>
    </box>
  );
}

function isPlanExecution(content: string): boolean {
  return content.startsWith("Execute this plan.");
}

function parsePlanTitle(content: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1] ?? "Plan";
}

const UserMessageAccent = memo(function UserMessageAccent({ msg }: { msg: ChatMessage }) {
  const time = formatTime(msg.timestamp);
  const expanded = useUIStore((s) => s.reasoningExpanded);
  const isPlan = isPlanExecution(msg.content);
  const borderColor = USER_COLOR;

  if (isPlan && !expanded) {
    const title = parsePlanTitle(msg.content);
    const lineCount = msg.content.split("\n").length;
    return (
      <box
        flexDirection="column"
        marginBottom={1}
        border={["left"]}
        borderColor={borderColor}
        customBorderChars={RAIL_BORDER}
        paddingLeft={2}
        paddingRight={1}
        paddingY={1}
        backgroundColor="#0a1218"
      >
        <box flexDirection="row">
          <text fg={borderColor} attributes={TextAttributes.BOLD}>
            You
          </text>
          <text fg="#333"> · {time}</text>
        </box>
        <box height={1}>
          <text truncate>
            <span fg={USER_COLOR}>{TOOL_ICONS.plan} </span>
            <span fg="#ccc">Execute plan: {title}</span>
            <span fg="#555"> ({String(lineCount)} lines)</span>
            <span fg="#333"> ^O</span>
          </text>
        </box>
      </box>
    );
  }

  return (
    <box
      flexDirection="column"
      marginBottom={1}
      border={["left"]}
      borderColor={borderColor}
      customBorderChars={RAIL_BORDER}
      paddingLeft={2}
      paddingRight={1}
      paddingY={1}
      backgroundColor="#0a1218"
    >
      <box flexDirection="row">
        <text fg={borderColor} attributes={TextAttributes.BOLD}>
          You
        </text>
        <text fg="#333"> · {time}</text>
        {msg.isSteering && <text fg="#FF8C00"> · steering</text>}
      </box>
      {msg.isSteering ? (
        <text truncate>
          {msg.content.split("\n")[0]}
          {msg.content.includes("\n") && (
            <span fg="#555"> [+{String(msg.content.split("\n").length - 1)} lines]</span>
          )}
        </text>
      ) : (
        truncateUserContent(msg.content, expanded)
      )}
    </box>
  );
});

const UserMessageBubble = memo(function UserMessageBubble({ msg }: { msg: ChatMessage }) {
  const time = formatTime(msg.timestamp);
  const expanded = useUIStore((s) => s.reasoningExpanded);

  return (
    <box flexDirection="column" alignItems="flex-end" marginBottom={1}>
      <box
        borderStyle="rounded"
        border={true}
        borderColor={USER_COLOR}
        paddingX={2}
        paddingY={1}
        backgroundColor="#0a1218"
      >
        {truncateUserContent(msg.content, expanded)}
      </box>
      <text fg="#555"> You · {time}</text>
    </box>
  );
});

function renderSegments(
  segments: MessageSegment[],
  toolCallMap: Map<string, ToolCall>,
  diffStyle: "default" | "sidebyside" | "compact" = "default",
  showReasoning = true,
  reasoningExpanded = false,
) {
  let firstToolsIdx = -1;
  for (let k = 0; k < segments.length; k++) {
    if (segments[k]?.type === "tools") {
      firstToolsIdx = k;
      break;
    }
  }

  let lastVisibleType: string | null = null;
  return segments.map((seg, i) => {
    if (seg.type === "reasoning" && !showReasoning) return null;

    const needsGap = lastVisibleType !== null && lastVisibleType !== seg.type;
    lastVisibleType = seg.type;

    if (seg.type === "text") {
      const isLastSegment = i === segments.length - 1;
      const hasToolsBefore = firstToolsIdx >= 0 && firstToolsIdx < i;
      const isFinalAnswer = isLastSegment && hasToolsBefore && seg.content.trim().length > 20;
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: stable segment order
        <box key={`text-${i}`} flexDirection="column" marginTop={needsGap ? 1 : 0}>
          {isFinalAnswer && (
            <box height={1} flexShrink={0} marginBottom={1}>
              <text fg="#333" truncate>
                {"─".repeat(60)}
              </text>
            </box>
          )}
          <Markdown text={seg.content} />
        </box>
      );
    }
    if (seg.type === "reasoning") {
      const rkey = `${seg.id}-${reasoningExpanded ? "exp" : "col"}`;
      return (
        <box key={rkey} flexDirection="column" marginTop={needsGap ? 1 : 0}>
          <ReasoningBlock content={seg.content} expanded={reasoningExpanded} id={seg.id} />
        </box>
      );
    }
    if (seg.type === "plan") {
      const doneSteps = seg.plan.steps.filter((s) => s.status === "done").length;
      const totalSteps = seg.plan.steps.length;
      const allDone = doneSteps === totalSteps;
      const planKey = `plan-${seg.plan.title.slice(0, 20)}-${String(seg.plan.createdAt)}`;
      return (
        <box
          key={planKey}
          flexDirection="column"
          flexShrink={0}
          marginTop={needsGap ? 1 : 0}
          border={["left"]}
          borderStyle="heavy"
          borderColor={allDone ? "#4a7" : "#00BFFF"}
          paddingLeft={1}
        >
          <text truncate>
            <span fg={allDone ? "#4a7" : "#00BFFF"}>{TOOL_ICONS.plan} </span>
            <span fg="#ccc" attributes={TextAttributes.BOLD}>
              {seg.plan.title}{" "}
            </span>
            <span fg="#555">
              {String(doneSteps)}/{String(totalSteps)}
            </span>
          </text>
          {seg.plan.steps.map((step) => {
            const isDone = step.status === "done";
            const isSkipped = step.status === "skipped";
            const stepIcon = isDone ? "✓" : isSkipped ? "⊘" : "○";
            const stepColor = isDone ? "#4a7" : isSkipped ? "#444" : "#555";
            return (
              <box key={step.id} height={1} flexShrink={0}>
                <text truncate>
                  <span fg={stepColor}>{stepIcon} </span>
                  <span fg={isDone ? "#888" : "#666"}>{step.label}</span>
                </text>
              </box>
            );
          })}
        </box>
      );
    }
    const allCalls = seg.toolCallIds
      .map((id: string) => toolCallMap.get(id))
      .filter(Boolean) as ToolCall[];
    if (allCalls.length === 0) return null;

    // Hide failed edits that were retried on the same file
    const calls = allCalls.filter((tc, idx) => {
      if (!isFailedEditCall(tc)) return true;
      const path = extractPathFromArgs(tc.args);
      if (!path) return true;
      for (let j = idx + 1; j < allCalls.length; j++) {
        const later = allCalls[j];
        if (later && EDIT_NAMES.has(later.name) && extractPathFromArgs(later.args) === path)
          return false;
      }
      return true;
    });
    if (calls.length === 0) return null;

    const groups: { type: "normal"; tc: ToolCall }[] | { type: "meta"; calls: ToolCall[] }[] = [];
    let metaBuf: ToolCall[] = [];
    const flushMeta = () => {
      if (metaBuf.length > 0) {
        (groups as { type: "meta"; calls: ToolCall[] }[]).push({ type: "meta", calls: metaBuf });
        metaBuf = [];
      }
    };
    for (const tc of calls) {
      if (META_TOOLS.has(tc.name)) {
        metaBuf.push(tc);
      } else {
        flushMeta();
        (groups as { type: "normal"; tc: ToolCall }[]).push({ type: "normal", tc });
      }
    }
    flushMeta();

    const toolsKey = `tools-${seg.toolCallIds[0] ?? String(i)}`;
    const typedGroups = groups as (
      | { type: "normal"; tc: ToolCall }
      | { type: "meta"; calls: ToolCall[] }
    )[];
    return (
      <box key={toolsKey} flexDirection="column" marginTop={needsGap ? 1 : 0}>
        {typedGroups.map((g, gi) => {
          if (g.type === "meta") {
            return <CollapsedToolGroup key={`meta-${String(gi)}`} calls={g.calls} />;
          }
          return (
            <box key={g.tc.id} flexDirection="column">
              {g.tc.name === "edit_file" ? (
                <EditToolCall tc={g.tc} diffStyle={diffStyle} />
              ) : g.tc.name === "write_plan" || g.tc.name === "plan" ? (
                <WritePlanCall tc={g.tc} />
              ) : (
                <ToolCallRow tc={g.tc} />
              )}
            </box>
          );
        })}
      </box>
    );
  });
}

const AssistantMessage = memo(function AssistantMessage({
  msg,
  diffStyle = "default",
  showReasoning = true,
  reasoningExpanded = false,
}: {
  msg: ChatMessage;
  diffStyle?: "default" | "sidebyside" | "compact";
  showReasoning?: boolean;
  reasoningExpanded?: boolean;
}) {
  const time = formatTime(msg.timestamp);

  const toolCallMap = useMemo(() => {
    const map = new Map<string, ToolCall>();
    for (const tc of msg.toolCalls ?? []) {
      map.set(tc.id, tc);
    }
    return map;
  }, [msg.toolCalls]);

  const hasSegments = msg.segments && msg.segments.length > 0;
  const hasContent = msg.content.trim().length > 0;
  const hasTools = msg.toolCalls && msg.toolCalls.length > 0;
  const isEmpty = !hasSegments && !hasContent && !hasTools;

  return (
    <box
      flexDirection="column"
      marginBottom={1}
      border={["left"]}
      borderColor={ASSISTANT_COLOR}
      customBorderChars={RAIL_BORDER}
      paddingLeft={2}
      paddingY={1}
    >
      <box flexDirection="row">
        <text fg={ASSISTANT_COLOR}>{icon("ai")} Forge</text>
        <text fg="#333"> {time}</text>
      </box>

      {isEmpty ? (
        <text fg="#555" attributes={TextAttributes.ITALIC}>
          Empty response — model returned no content.
        </text>
      ) : hasSegments ? (
        renderSegments(
          msg.segments as MessageSegment[],
          toolCallMap,
          diffStyle,
          showReasoning,
          reasoningExpanded,
        )
      ) : (
        <>
          {hasContent && <Markdown text={msg.content} />}
          {hasTools && (
            <box flexDirection="column">
              {msg.toolCalls
                ?.filter((tc) => tc.name !== "task_list" && tc.name !== "update_plan_step")
                .map((tc) => (
                  <box key={tc.id} flexDirection="column">
                    {tc.name === "edit_file" ? (
                      <EditToolCall tc={tc} diffStyle={diffStyle} />
                    ) : (
                      <ToolCallRow tc={tc} />
                    )}
                  </box>
                ))}
            </box>
          )}
        </>
      )}
    </box>
  );
});

export const StaticMessage = memo(function StaticMessage({
  msg,
  chatStyle,
  diffStyle = "default",
  showReasoning = true,
  reasoningExpanded = false,
  animate = false,
}: {
  msg: ChatMessage;
  chatStyle: ChatStyle;
  diffStyle?: "default" | "sidebyside" | "compact";
  showReasoning?: boolean;
  reasoningExpanded?: boolean;
  animate?: boolean;
}) {
  if (msg.role === "system") {
    return (
      <box flexDirection="column" paddingX={1} width="100%">
        <SystemMessage msg={msg} animate={animate} />
      </box>
    );
  }
  if (msg.role === "user") {
    return (
      <box flexDirection="column" paddingX={1} width="100%">
        {chatStyle === "bubble" ? <UserMessageBubble msg={msg} /> : <UserMessageAccent msg={msg} />}
      </box>
    );
  }
  return (
    <box flexDirection="column" paddingX={1} width="100%">
      <AssistantMessage
        msg={msg}
        diffStyle={diffStyle}
        showReasoning={showReasoning}
        reasoningExpanded={reasoningExpanded}
      />
    </box>
  );
});

export const MessageList = memo(function MessageList({
  messages,
  chatStyle,
  diffStyle = "default",
  showReasoning = true,
}: Props) {
  const lastSystemIdx = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "system") return i;
    }
    return -1;
  }, [messages]);

  if (messages.length === 0) {
    return (
      <box flexDirection="column" paddingX={1} width="100%">
        <box marginTop={1}>
          <text fg="#555" attributes={TextAttributes.ITALIC}>
            No messages yet. Type below to start.
          </text>
        </box>
      </box>
    );
  }

  return (
    <box flexDirection="column" paddingX={1} width="100%">
      {messages.map((msg, idx) => {
        if (msg.role === "system") {
          return <SystemMessage key={msg.id} msg={msg} animate={idx === lastSystemIdx} />;
        }

        if (msg.role === "user") {
          return chatStyle === "bubble" ? (
            <UserMessageBubble key={msg.id} msg={msg} />
          ) : (
            <UserMessageAccent key={msg.id} msg={msg} />
          );
        }

        return (
          <AssistantMessage
            key={msg.id}
            msg={msg}
            diffStyle={diffStyle}
            showReasoning={showReasoning}
          />
        );
      })}
    </box>
  );
});
