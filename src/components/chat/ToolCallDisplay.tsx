import { TextAttributes } from "@opentui/core";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { AgentStatsEvent, SubagentStep } from "../../core/agents/subagent-events.js";
import { icon } from "../../core/icons.js";
import {
  CATEGORY_COLORS,
  getBackendLabel,
  resolveToolDisplay,
  TOOL_ICONS,
  type ToolCategory,
} from "../../core/tool-display.js";
import type { PlanOutput } from "../../types/index.js";
import { SPINNER_FRAMES, useSpinnerFrame } from "../layout/shared.js";
import { StructuredPlanView } from "../plan/StructuredPlanView.js";
import { useDispatchDisplay } from "./dispatch-display.js";
import {
  type AgentInfo,
  CACHE_ICONS,
  humanizeTokens,
  shortModelId,
} from "./multi-agent-display.js";
import { buildLiveToolRowProps, ROW_COLORS, StaticToolRow } from "./StaticToolRow.js";

export interface LiveToolCall {
  id: string;
  toolName: string;
  state: "running" | "done" | "error";
  args?: string;
  result?: string;
  error?: string;
  /** Set at tool-call start when the backend is known upfront (e.g. routed web search agent). */
  backend?: string;
}

export const SUBAGENT_NAMES = new Set(["dispatch", "web_search"]);

const SPINNER_DEFAULT_COLOR = "#9B30FF";

export const RENDER_DEBOUNCE = 80;

const Spinner = memo(function Spinner({ color }: { color?: string }) {
  const frame = useSpinnerFrame();
  return <span fg={color ?? SPINNER_DEFAULT_COLOR}>{SPINNER_FRAMES[frame]}</span>;
});

function useElapsedTimers(calls: LiveToolCall[]) {
  const startTimes = useRef(new Map<string, number>());
  const callsRef = useRef(calls);
  callsRef.current = calls;
  const [elapsed, setElapsed] = useState(new Map<string, number>());

  useEffect(() => {
    const activeIds = new Set<string>();
    for (const call of calls) {
      activeIds.add(call.id);
      if (call.state === "running" && !startTimes.current.has(call.id)) {
        startTimes.current.set(call.id, Date.now());
      }
    }
    for (const id of startTimes.current.keys()) {
      if (!activeIds.has(id)) startTimes.current.delete(id);
    }
  }, [calls]);

  const hasRunning = calls.some((c) => c.state === "running");

  useEffect(() => {
    if (!hasRunning) return;

    const interval = setInterval(() => {
      const now = Date.now();
      setElapsed((prev) => {
        let changed = false;
        const next = new Map<string, number>();
        for (const call of callsRef.current) {
          const start = startTimes.current.get(call.id);
          if (start) {
            const secs = Math.floor((now - start) / 1000);
            next.set(call.id, secs);
            if (prev.get(call.id) !== secs) changed = true;
          }
        }
        if (!changed && prev.size === next.size) return prev;
        return next;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [hasRunning]);

  return elapsed;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return secs > 0 ? `${String(mins)}m ${String(secs)}s` : `${String(mins)}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${String(hrs)}h ${String(remMins)}m` : `${String(hrs)}h`;
}

const ChildStepRow = memo(
  function ChildStepRow({ step }: { step: SubagentStep }) {
    const {
      icon,
      iconColor,
      label,
      category: staticCategory,
    } = resolveToolDisplay(step.toolName, "#666");
    const hasSplit = !!(step.backend && staticCategory && step.backend !== staticCategory);
    const category = hasSplit ? staticCategory : (step.backend ?? staticCategory);
    const backendTag = hasSplit ? step.backend : null;
    const categoryColor =
      (staticCategory ? CATEGORY_COLORS[staticCategory as ToolCategory] : null) ??
      (step.backend ? (CATEGORY_COLORS[step.backend as ToolCategory] ?? "#888") : undefined) ??
      "#888";
    const backendColor = backendTag
      ? (CATEGORY_COLORS[backendTag as ToolCategory] ?? "#888")
      : undefined;
    const isDone = step.state !== "running";

    const cacheIcon = step.cacheState ? (CACHE_ICONS[step.cacheState] ?? "") : "";
    const cacheColor = step.cacheState ? (CACHE_COLORS[step.cacheState] ?? "#888") : "";
    const cacheLabel = getCacheLabel(step);

    return (
      <box height={1} flexShrink={0} marginLeft={3}>
        <text truncate>
          <span fg="#333">├ </span>
          {step.cacheState === "wait" ? (
            <Spinner color={CACHE_COLORS.wait} />
          ) : step.state === "running" ? (
            <Spinner color="#666" />
          ) : step.state === "done" ? (
            <span fg="#4a7">✓</span>
          ) : (
            <span fg="#f44">✗</span>
          )}
          <span fg={isDone ? "#444" : iconColor}> {icon} </span>
          {category ? <span fg={isDone ? "#333" : categoryColor}>[{category}]</span> : null}
          {backendTag ? (
            <span fg={isDone ? "#333" : backendColor}>[{getBackendLabel(backendTag)}] </span>
          ) : category ? (
            <span> </span>
          ) : null}
          <span fg={isDone ? "#444" : "#888"}>{label}</span>
          {step.agentId ? <span fg={isDone ? "#333" : "#9B30FF"}> [{step.agentId}]</span> : null}
          {step.args ? <span fg={isDone ? "#333" : "#666"}> {step.args}</span> : null}
          {cacheIcon ? (
            <span fg={cacheColor}>
              {" "}
              {cacheIcon} {cacheLabel}
            </span>
          ) : null}
        </text>
      </box>
    );
  },
  (prev, next) =>
    prev.step.toolName === next.step.toolName &&
    prev.step.args === next.step.args &&
    prev.step.state === next.step.state &&
    prev.step.cacheState === next.step.cacheState &&
    prev.step.sourceAgentId === next.step.sourceAgentId &&
    prev.step.backend === next.step.backend &&
    prev.step.agentId === next.step.agentId,
);

const CACHE_COLORS: Record<string, string> = {
  hit: "#4a7",
  wait: "#FFDD57",
  store: "#5af",
  invalidate: "#f80",
};

function getCacheLabel(step: SubagentStep): string {
  switch (step.cacheState) {
    case "hit":
      return step.sourceAgentId ? `from ${step.sourceAgentId}` : "from cache";
    case "wait":
      return step.sourceAgentId ? `waiting on ${step.sourceAgentId}` : "waiting";
    case "store":
      return "cached";
    case "invalidate":
      return "updated cache";
    default:
      return "";
  }
}

const MultiAgentChildRow = memo(
  function MultiAgentChildRow({
    agentId,
    info,
    isLast,
    childSteps,
    liveStats,
  }: {
    agentId: string;
    info: AgentInfo;
    isLast: boolean;
    childSteps: SubagentStep[];
    liveStats?: AgentStatsEvent;
  }) {
    const roleIcon =
      info.role === "investigate"
        ? icon("investigate")
        : info.role === "explore"
          ? icon("explore")
          : icon("code");
    const roleColor =
      info.role === "investigate" ? "#00CED1" : info.role === "code" ? "#FF6B2B" : "#9B30FF";
    const isDone = info.state === "done" || info.state === "error";
    const isPending = info.state === "pending";
    const taskStr = info.task.length > 40 ? `${info.task.slice(0, 37)}...` : info.task;
    const connector = isLast ? "└ " : "├ ";
    const continuation = isLast ? "  " : "│ ";

    const toolUses = isDone ? info.toolUses : liveStats?.toolUses;
    const stepCount = liveStats?.stepCount;
    const tokenUsage = isDone ? info.tokenUsage : liveStats?.tokenUsage;
    const cacheHits = isDone ? info.cacheHits : liveStats?.cacheHits;

    const modelLabel = info.modelId ? shortModelId(info.modelId) : null;
    const isTrivial = info.tier === "trivial";
    const isDesloppify = info.tier === "desloppify";
    const hasTier = isTrivial || isDesloppify;
    const tierIcon = isTrivial ? icon("trivial") : isDesloppify ? icon("cleanup") : "";
    const tierName = isTrivial ? "trivial" : isDesloppify ? "cleanup" : "";
    const tierColor = isTrivial ? "#d9a020" : "#2dd4bf";

    return (
      <>
        <box height={1} flexShrink={0} marginLeft={3}>
          <text truncate>
            <span fg="#333">{connector}</span>
            {info.state === "running" ? (
              <Spinner color={roleColor} />
            ) : info.state === "done" ? (
              info.calledDone ? (
                <span fg="#4a7">✓</span>
              ) : (
                <span fg="#d9a020">!</span>
              )
            ) : info.state === "error" ? (
              <span fg="#f44">✗</span>
            ) : (
              <span fg="#555">○</span>
            )}
            <span fg={isDone ? "#444" : roleColor}> {roleIcon} </span>
            <span
              fg={isDone ? "#444" : "#ddd"}
              attributes={!isDone ? TextAttributes.BOLD : undefined}
            >
              {agentId}
            </span>
            <span fg={isDone ? "#333" : roleColor}> [{info.role}]</span>
            {hasTier ? (
              <span fg={isDone ? "#444" : tierColor}>
                [{tierIcon} {tierName}]
              </span>
            ) : null}
            {modelLabel ? (
              <span fg={isDone ? "#444" : "#5a9"}>
                [{icon("model")} {modelLabel}]
              </span>
            ) : null}
            {stepCount != null && stepCount > 0 && !isDone ? (
              <span fg="#8a6">
                [{icon("gear")} {String(stepCount)}]
              </span>
            ) : toolUses != null && toolUses > 0 ? (
              <span fg={isDone ? "#444" : "#8a6"}>
                [{icon("gear")} {String(toolUses)}]
              </span>
            ) : null}
            {tokenUsage && tokenUsage.total > 0 ? (
              <span fg={isDone ? "#444" : "#7a8"}>
                [{icon("gauge")}{" "}
                {isDone && tokenUsage.input > 0
                  ? `${humanizeTokens(tokenUsage.input)}↓ ${humanizeTokens(tokenUsage.output)}↑`
                  : humanizeTokens(tokenUsage.total)}
                ]
              </span>
            ) : null}
            {cacheHits && cacheHits > 0 ? (
              <span fg={isDone ? "#444" : "#d9a020"}>
                [{icon("cache")} {humanizeTokens(cacheHits)}]
              </span>
            ) : null}
            {isPending && info.dependsOn && info.dependsOn.length > 0 ? (
              <span fg="#555"> waiting on {info.dependsOn.join(", ")}</span>
            ) : (
              <span fg={isDone ? "#333" : "#666"}> {taskStr}</span>
            )}
          </text>
        </box>
        {(() => {
          const agentDone = info.state === "done" || info.state === "error";
          const MAX_VISIBLE = agentDone ? 3 : 6;
          const filtered = childSteps.filter((s) => !QUIET_TOOLS.has(s.toolName));
          const running = filtered.filter((s) => s.state === "running");
          const done = filtered.filter((s) => s.state !== "running");
          const doneSlots = Math.max(0, MAX_VISIBLE - running.length);
          const visibleDone = done.slice(-doneSlots);
          const hiddenCount = done.length - visibleDone.length;
          const visible = [...visibleDone, ...running];
          const agentRunning = info.state === "running";
          const showThinking = agentRunning && running.length === 0 && done.length > 0;

          return (
            <>
              {hiddenCount > 0 && (
                <box height={1} flexShrink={0} marginLeft={3}>
                  <text truncate>
                    <span fg="#333">
                      {continuation}
                      {"  "}├{" "}
                    </span>
                    <span fg="#444">+{String(hiddenCount)} completed</span>
                  </text>
                </box>
              )}
              {visible.map((step, i) => {
                const {
                  icon: stepIcon,
                  iconColor: stepColor,
                  label: stepLabel,
                  category: stepStaticCategory,
                } = resolveToolDisplay(step.toolName, "#666");
                const stepHasSplit = !!(
                  step.backend &&
                  stepStaticCategory &&
                  step.backend !== stepStaticCategory
                );
                const stepCategory = stepHasSplit
                  ? stepStaticCategory
                  : (step.backend ?? stepStaticCategory);
                const stepBackendTag = stepHasSplit ? step.backend : null;
                const stepCatColor =
                  (stepStaticCategory
                    ? CATEGORY_COLORS[stepStaticCategory as ToolCategory]
                    : null) ??
                  (step.backend
                    ? (CATEGORY_COLORS[step.backend as ToolCategory] ?? "#888")
                    : undefined) ??
                  "#888";
                const stepBackendColor = stepBackendTag
                  ? (CATEGORY_COLORS[stepBackendTag as ToolCategory] ?? "#888")
                  : undefined;
                const stepDone = step.state !== "running";
                const stepLast = i === visible.length - 1 && !showThinking;
                const stepConnector = stepLast ? "└ " : "├ ";
                const origIdx = childSteps.indexOf(step);

                const cacheIcon = step.cacheState ? (CACHE_ICONS[step.cacheState] ?? "") : "";
                const cacheColor = step.cacheState ? (CACHE_COLORS[step.cacheState] ?? "#888") : "";
                const cacheLabel = getCacheLabel(step);

                return (
                  <box
                    key={`${step.toolName}-${String(origIdx)}`}
                    height={1}
                    flexShrink={0}
                    marginLeft={3}
                  >
                    <text truncate>
                      <span fg="#333">
                        {continuation}
                        {"  "}
                        {stepConnector}
                      </span>
                      {step.cacheState === "wait" ? (
                        <Spinner color={CACHE_COLORS.wait} />
                      ) : step.state === "running" ? (
                        <Spinner color="#666" />
                      ) : step.state === "done" ? (
                        <span fg="#4a7">✓</span>
                      ) : (
                        <span fg="#f44">✗</span>
                      )}
                      <span fg={stepDone ? "#444" : stepColor}> {stepIcon} </span>
                      {stepCategory ? (
                        <span fg={stepDone ? "#333" : stepCatColor}>[{stepCategory}]</span>
                      ) : null}
                      {stepBackendTag ? (
                        <span fg={stepDone ? "#333" : stepBackendColor}>
                          [{getBackendLabel(stepBackendTag)}]{" "}
                        </span>
                      ) : stepCategory ? (
                        <span> </span>
                      ) : null}
                      <span fg={stepDone ? "#444" : "#888"}>{stepLabel}</span>
                      {step.args ? <span fg={stepDone ? "#333" : "#666"}> {step.args}</span> : null}
                      {cacheIcon ? (
                        <span fg={cacheColor}>
                          {" "}
                          {cacheIcon} {cacheLabel}
                        </span>
                      ) : null}
                    </text>
                  </box>
                );
              })}
              {showThinking && (
                <box height={1} flexShrink={0} marginLeft={3}>
                  <text truncate>
                    <span fg="#333">
                      {continuation}
                      {"  "}└{" "}
                    </span>
                    <Spinner color="#555" />
                    <span fg="#555"> thinking...</span>
                  </text>
                </box>
              )}
            </>
          );
        })()}
      </>
    );
  },
  (prev, next) =>
    prev.agentId === next.agentId &&
    prev.isLast === next.isLast &&
    prev.info.state === next.info.state &&
    prev.info.role === next.info.role &&
    prev.info.toolUses === next.info.toolUses &&
    prev.info.cacheHits === next.info.cacheHits &&
    prev.info.tokenUsage?.total === next.info.tokenUsage?.total &&
    prev.childSteps.length === next.childSteps.length &&
    prev.childSteps.every((s, i) => {
      const n = next.childSteps[i];
      return (
        n &&
        s.toolName === n.toolName &&
        s.state === n.state &&
        s.args === n.args &&
        s.cacheState === n.cacheState
      );
    }) &&
    prev.liveStats?.toolUses === next.liveStats?.toolUses &&
    prev.liveStats?.tokenUsage?.total === next.liveStats?.tokenUsage?.total &&
    prev.liveStats?.cacheHits === next.liveStats?.cacheHits,
);

const ToolRow = memo(
  function ToolRow({
    tc,
    seconds,
    diffStyle = "default",
  }: {
    tc: LiveToolCall;
    seconds?: number;
    diffStyle?: "default" | "sidebyside" | "compact";
  }) {
    const isSubagent = SUBAGENT_NAMES.has(tc.toolName);
    const multiAgentInfo = useMemo(() => {
      if (tc.toolName !== "dispatch" || !tc.args) return null;
      try {
        const parsed = JSON.parse(tc.args);
        if (Array.isArray(parsed.tasks) && parsed.tasks.length >= 1) {
          const tasks = (
            parsed.tasks as Array<{
              id?: string;
              agentId?: string;
              role?: string;
              task?: string;
              dependsOn?: string[];
            }>
          ).map((t, i) => ({
            agentId: t.id ?? t.agentId ?? `agent-${String(i + 1)}`,
            role: t.role,
            task: t.task,
            dependsOn: t.dependsOn,
          }));
          return { totalAgents: parsed.tasks.length as number, tasks };
        }
      } catch {}
      return null;
    }, [tc.toolName, tc.args]);
    const isMultiAgent = multiAgentInfo !== null;

    const dispatchId = isSubagent ? tc.id : null;
    const {
      steps: allChildSteps,
      progress: multiProgress,
      stats: liveStats,
    } = useDispatchDisplay(
      dispatchId,
      (multiAgentInfo?.totalAgents ?? 1) * 15,
      multiAgentInfo?.totalAgents ?? 0,
      multiAgentInfo?.tasks,
    );

    const isRepoMapHit = useMemo(() => {
      if (!tc.result) return false;
      try {
        const parsed = JSON.parse(tc.result);
        return parsed.repoMapHit === true;
      } catch {
        return false;
      }
    }, [tc.result]);

    const dispatchRejection = useMemo(() => {
      if (tc.toolName !== "dispatch" || tc.state !== "done" || !tc.result) return null;
      try {
        const p = JSON.parse(tc.result);
        if (p.reads) return null;
      } catch {}
      const match = tc.result.match(/(?:⛔|⚠️)\s*dispatch\s*\[rejected\s*→\s*(.+?)\]/);
      return match?.[1] ?? null;
    }, [tc.toolName, tc.state, tc.result]);

    // Build suffix (dispatch/elapsed/result — streaming-specific logic)
    let suffix = "";
    let suffixColor: string | undefined;
    if (isMultiAgent) {
      const total = multiProgress?.totalAgents ?? multiAgentInfo?.totalAgents ?? 0;
      const done = multiProgress
        ? [...multiProgress.agents.values()].filter(
            (a) => a.state === "done" || a.state === "error",
          ).length
        : 0;
      if (tc.state === "done" && dispatchRejection) {
        suffix = ` → rejected — ${dispatchRejection}`;
        suffixColor = "#d9a020";
      } else if (tc.state === "running") {
        const parts: string[] = [];
        if (seconds != null && seconds > 0) parts.push(formatDuration(seconds));
        if (total > 0) parts.push(`${String(done)}/${String(total)} agents`);
        if (multiProgress && multiProgress.findingCount > 0)
          parts.push(`${String(multiProgress.findingCount)} findings`);
        suffix = parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
      } else if (tc.state === "done") {
        suffix = ` → ${String(done)}/${String(total)} agents`;
      }
    } else if (tc.state === "running" && seconds != null && seconds > 0) {
      suffix = ` ${formatDuration(seconds)}`;
    } else if (tc.state === "error" && tc.error) {
      suffix = ` → ${tc.error.slice(0, 50)}`;
      suffixColor = ROW_COLORS.error;
    }
    // For non-dispatch done calls, suffix comes from buildLiveToolRowProps via formatResult

    const repoMapIcon = TOOL_ICONS._repomap ?? "◈";
    const staticProps = buildLiveToolRowProps(tc, {
      isRepoMapHit,
      repoMapIcon,
      suffix: suffix || undefined,
      suffixColor,
      dispatchRejection,
      diffStyle,
    });

    // Status content: Spinner for running, static icon for done/error
    const statusContent =
      tc.state === "running" ? (
        <Spinner />
      ) : tc.state === "error" ? (
        <span fg={ROW_COLORS.error}>✗</span>
      ) : (
        (() => {
          if (tc.result) {
            try {
              const parsed = JSON.parse(tc.result);
              if (parsed.success === false) return <span fg="#d9a020">!</span>;
            } catch {}
          }
          return <span fg={ROW_COLORS.checkDone}>✓</span>;
        })()
      );

    return (
      <box flexDirection="column">
        <StaticToolRow {...staticProps} statusContent={statusContent} />
        {isMultiAgent &&
          multiProgress !== null &&
          multiProgress.agents.size > 0 &&
          !dispatchRejection && (
            <box flexDirection="column" marginLeft={2}>
              {[...multiProgress.agents.entries()].map(([agentId, info], idx, arr) => {
                const agentSteps = allChildSteps.filter((s) => s.agentId === agentId);
                const isLastVisible = idx === arr.length - 1;
                const allAccountedFor = arr.length >= (multiProgress.totalAgents ?? arr.length);
                return (
                  <MultiAgentChildRow
                    key={agentId}
                    agentId={agentId}
                    info={info}
                    isLast={isLastVisible && allAccountedFor}
                    childSteps={agentSteps}
                    liveStats={liveStats.get(agentId)}
                  />
                );
              })}
            </box>
          )}
        {isSubagent && !isMultiAgent && allChildSteps.length > 0 && (
          <box flexDirection="column">
            {(() => {
              const MAX_SINGLE = 5;
              const filtered = allChildSteps.filter((s) => !QUIET_TOOLS.has(s.toolName));
              const running = filtered.filter((s) => s.state === "running");
              const done = filtered.filter((s) => s.state !== "running");
              const doneSlots = Math.max(0, MAX_SINGLE - running.length);
              const visibleDone = done.slice(-doneSlots);
              const hiddenCount = done.length - visibleDone.length;
              const visible = [...visibleDone, ...running];
              const agentRunning = tc.state === "running";
              const showThinking = agentRunning && running.length === 0 && done.length > 0;

              return (
                <>
                  {hiddenCount > 0 && (
                    <box height={1} flexShrink={0} marginLeft={3}>
                      <text truncate>
                        <span fg="#333">├ </span>
                        <span fg="#444">+{String(hiddenCount)} completed</span>
                      </text>
                    </box>
                  )}
                  {visible.map((step) => {
                    const stableIdx = allChildSteps.indexOf(step);
                    return (
                      <ChildStepRow key={`${step.toolName}-${String(stableIdx)}`} step={step} />
                    );
                  })}
                  {showThinking && (
                    <box height={1} flexShrink={0} marginLeft={3}>
                      <text truncate>
                        <span fg="#333">└ </span>
                        <Spinner color="#555" />
                        <span fg="#555"> thinking...</span>
                      </text>
                    </box>
                  )}
                </>
              );
            })()}
          </box>
        )}
      </box>
    );
  },
  (prev, next) =>
    prev.tc.id === next.tc.id &&
    prev.tc.state === next.tc.state &&
    prev.tc.args === next.tc.args &&
    prev.tc.result === next.tc.result &&
    prev.tc.error === next.tc.error &&
    prev.tc.backend === next.tc.backend &&
    prev.seconds === next.seconds &&
    prev.diffStyle === next.diffStyle,
);

const QUIET_TOOLS = new Set(["update_plan_step", "ask_user", "task_list"]);

const EDIT_TOOL_NAMES = new Set(["edit_file", "multi_edit"]);

function isEditTool(name: string): boolean {
  return EDIT_TOOL_NAMES.has(name);
}

function isFailedEdit(tc: LiveToolCall): boolean {
  if (!isEditTool(tc.toolName) || tc.state !== "done") return false;
  try {
    const parsed = JSON.parse(tc.result ?? "");
    return parsed.success === false;
  } catch {
    return false;
  }
}

function extractPath(args?: string): string | null {
  if (!args) return null;
  try {
    const parsed = JSON.parse(args);
    return typeof parsed.path === "string" ? parsed.path : null;
  } catch {
    const m = args.match(/"path"\s*:\s*"([^"]+)"/);
    return m?.[1] ?? null;
  }
}

interface Props {
  calls: LiveToolCall[];
  verbose?: boolean;
  diffStyle?: "default" | "sidebyside" | "compact";
}

export const ToolCallDisplay = memo(function ToolCallDisplay({
  calls,
  verbose = false,
  diffStyle = "default",
}: Props) {
  const elapsed = useElapsedTimers(calls);

  if (calls.length === 0) return null;

  const visible = calls.filter((tc, idx) => {
    if (QUIET_TOOLS.has(tc.toolName) && !(verbose && tc.toolName === "ask_user")) return false;
    // Hide failed edits that were retried successfully on the same file
    if (isFailedEdit(tc)) {
      const path = extractPath(tc.args);
      if (path) {
        for (let j = idx + 1; j < calls.length; j++) {
          const later = calls[j];
          if (later && isEditTool(later.toolName) && extractPath(later.args) === path) return false;
        }
      }
    }
    return true;
  });

  return (
    <box flexDirection="column">
      {visible.map((tc) => {
        const seconds = elapsed.get(tc.id);
        if ((tc.toolName === "write_plan" || tc.toolName === "plan") && tc.args) {
          try {
            const plan = JSON.parse(tc.args) as PlanOutput;
            if (plan.title && Array.isArray(plan.steps) && Array.isArray(plan.files)) {
              return (
                <box key={tc.id} flexDirection="column">
                  <StructuredPlanView plan={plan} result={tc.result} />
                  {tc.state === "running" && (
                    <box height={1} flexShrink={0} marginTop={1}>
                      <text>
                        <span fg="#555">◎ </span>
                        <span fg="#b87333"> Awaiting review</span>
                        <span fg="#555"> — select below</span>
                      </text>
                    </box>
                  )}
                </box>
              );
            }
          } catch {}
        }
        return <ToolRow key={tc.id} tc={tc} seconds={seconds} diffStyle={diffStyle} />;
      })}
    </box>
  );
});
