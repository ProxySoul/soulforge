import { TextAttributes } from "@opentui/core";
import type { ReactNode } from "react";
import {
  CATEGORY_COLORS,
  getBackendLabel,
  resolveToolDisplay,
  type ToolCategory,
} from "../../core/tool-display.js";
import { DiffView } from "./DiffView.js";
import { detectOutsideCwd, formatArgs, formatResult, OUTSIDE_BADGE } from "./tool-formatters.js";

export const ROW_COLORS = {
  textDone: "#555",
  toolNameActive: "#9B30FF",
  argsActive: "#aaa",
  checkDone: "#4a7",
  error: "#f44",
} as const;

export interface StaticToolRowProps {
  statusContent: ReactNode;
  isDone: boolean;
  icon: string;
  iconColor: string;
  label: string;
  category?: string;
  categoryColor?: string;
  backendTag?: string;
  backendColor?: string;
  outsideBadge?: { label: string; color: string } | null;
  argStr?: string;
  /** When set, replaces label+args with this text (e.g. edit result summary) */
  editResultText?: string;
  suffix?: string;
  suffixColor?: string;
  /** Render a diff view below the main row */
  diff?: {
    path: string;
    oldString: string;
    newString: string;
    success: boolean;
    errorMessage?: string;
    impact?: string;
  } | null;
  diffStyle?: "default" | "sidebyside" | "compact";
}

/**
 * Pure render component for a single tool call row.
 * No hooks — shared between streaming (ToolCallDisplay) and final (MessageList) views.
 */
export function StaticToolRow({
  statusContent,
  isDone,
  icon,
  iconColor,
  label,
  category,
  categoryColor,
  backendTag,
  backendColor,
  outsideBadge,
  argStr,
  editResultText,
  suffix,
  suffixColor,
  diff,
  diffStyle = "default",
}: StaticToolRowProps) {
  return (
    <box flexDirection="column">
      <box height={1} flexShrink={0}>
        <text truncate>
          {statusContent}
          <span fg={isDone ? ROW_COLORS.textDone : iconColor}> {icon} </span>
          {category ? <span fg={isDone ? "#444" : categoryColor}>[{category}]</span> : null}
          {backendTag ? (
            <span fg={isDone ? "#444" : backendColor}>[{getBackendLabel(backendTag)}] </span>
          ) : category ? (
            <span> </span>
          ) : null}
          {outsideBadge ? (
            <span fg={isDone ? "#444" : outsideBadge.color}>[{outsideBadge.label}] </span>
          ) : null}
          {editResultText ? (
            <span fg={ROW_COLORS.textDone}>{editResultText}</span>
          ) : (
            <>
              <span
                fg={isDone ? ROW_COLORS.textDone : ROW_COLORS.toolNameActive}
                attributes={!isDone ? TextAttributes.BOLD : undefined}
              >
                {label}
              </span>
              {argStr ? (
                <span fg={isDone ? ROW_COLORS.textDone : ROW_COLORS.argsActive}> {argStr}</span>
              ) : null}
            </>
          )}
          {suffix ? <span fg={suffixColor ?? ROW_COLORS.textDone}>{suffix}</span> : null}
        </text>
      </box>
      {diff ? (
        <box marginLeft={2} flexDirection="column">
          <DiffView
            filePath={diff.path}
            oldString={diff.oldString}
            newString={diff.newString}
            success={diff.success}
            errorMessage={diff.errorMessage}
            mode={diffStyle}
          />
          {diff.impact ? (
            <text fg="#666">
              {"  "}
              <span fg="#c89030">{"⚡"}</span>
              <span fg="#888"> {diff.impact}</span>
            </text>
          ) : null}
        </box>
      ) : null}
    </box>
  );
}

// ── Helpers for converting data shapes to StaticToolRowProps ──

const EDIT_TOOL_NAMES = new Set(["edit_file", "multi_edit"]);

/** Build props from a LiveToolCall (streaming path) — call this from ToolRow */
export function buildLiveToolRowProps(
  tc: {
    toolName: string;
    state: "running" | "done" | "error";
    args?: string;
    result?: string;
    error?: string;
    backend?: string;
  },
  extra?: {
    isRepoMapHit?: boolean;
    repoMapIcon?: string;
    suffix?: string;
    suffixColor?: string;
    dispatchRejection?: string | null;
    diffStyle?: "default" | "sidebyside" | "compact";
  },
): Omit<StaticToolRowProps, "statusContent"> {
  const isRepoMapHit = extra?.isRepoMapHit ?? false;
  const toolDisplay = resolveToolDisplay(tc.toolName);
  const repoMapIcon = extra?.repoMapIcon ?? "◈";

  const iconVal = isRepoMapHit ? repoMapIcon : toolDisplay.icon;
  const labelVal = isRepoMapHit ? "Soul Map" : toolDisplay.label;
  const iconColorVal = isRepoMapHit ? "#2dd4bf" : toolDisplay.iconColor;
  const staticCategory = isRepoMapHit ? ("soul-map" as ToolCategory) : toolDisplay.category;

  // Backend from result or prop
  let backendCategory: string | null = null;
  if (!isRepoMapHit) {
    if (tc.result) {
      try {
        const parsed = JSON.parse(tc.result);
        if (parsed.backend && typeof parsed.backend === "string") {
          backendCategory = parsed.backend as string;
        }
      } catch {}
    }
    if (!backendCategory) backendCategory = tc.backend ?? null;
  }

  const hasSplit = !!(backendCategory && staticCategory && backendCategory !== staticCategory);
  const category = hasSplit ? staticCategory : (backendCategory ?? staticCategory);
  const backendTag = hasSplit ? backendCategory : null;
  const categoryColor =
    (staticCategory ? CATEGORY_COLORS[staticCategory as ToolCategory] : null) ??
    (backendCategory ? (CATEGORY_COLORS[backendCategory as ToolCategory] ?? "#888") : undefined) ??
    "#888";
  const backendColorVal = backendTag
    ? (CATEGORY_COLORS[backendTag as ToolCategory] ?? "#888")
    : undefined;

  const isDone = tc.state !== "running";
  const argStr = formatArgs(tc.toolName, tc.args);
  const outsideKind = detectOutsideCwd(tc.toolName, tc.args);
  const isEdit = EDIT_TOOL_NAMES.has(tc.toolName);

  const editResultText =
    isDone && isEdit && tc.result ? formatResult(tc.toolName, tc.result) : undefined;

  // Diff extraction for edit tools
  let diff: StaticToolRowProps["diff"] = null;
  if (tc.toolName === "edit_file" && tc.state === "done" && tc.args) {
    try {
      const parsed = JSON.parse(tc.args);
      if (
        typeof parsed.path === "string" &&
        typeof parsed.oldString === "string" &&
        typeof parsed.newString === "string"
      ) {
        let editSuccess = false;
        let editError: string | undefined;
        let editImpact: string | undefined;
        if (tc.result) {
          try {
            const rp = JSON.parse(tc.result);
            editSuccess = rp.success === true;
            if (!rp.success && rp.error) editError = rp.error as string;
            if (editSuccess && typeof rp.output === "string") {
              const m = rp.output.match(/\[impact: (.+)\]/);
              if (m?.[1]) editImpact = m[1];
            }
          } catch {}
        }
        diff = {
          path: parsed.path as string,
          oldString: parsed.oldString as string,
          newString: parsed.newString as string,
          success: editSuccess,
          errorMessage: editError,
          impact: editImpact,
        };
      }
    } catch {}
  }

  // Compute suffix: caller can override, otherwise derive from result for done non-edit calls
  let suffix = extra?.suffix;
  const suffixColor = extra?.suffixColor;
  if (!suffix && isDone && tc.result && !isEdit && !diff) {
    const r = formatResult(tc.toolName, tc.result);
    if (r) {
      suffix = ` → ${r}`;
    }
  }

  return {
    isDone,
    icon: iconVal,
    iconColor: iconColorVal,
    label: labelVal,
    category: category ?? undefined,
    categoryColor,
    backendTag: backendTag ?? undefined,
    backendColor: backendColorVal,
    outsideBadge: outsideKind ? OUTSIDE_BADGE[outsideKind] : null,
    argStr: argStr || undefined,
    editResultText,
    suffix,
    suffixColor,
    diff,
    diffStyle: extra?.diffStyle,
  };
}

/** Build props from a completed ToolCall (final/MessageList path) */
export function buildFinalToolRowProps(tc: {
  name: string;
  args: Record<string, unknown>;
  result?: { success: boolean; output: string; error?: string; backend?: string };
}): StaticToolRowProps {
  const toolDisplay = resolveToolDisplay(tc.name);
  const argsJson = JSON.stringify(tc.args);
  const resultJson = tc.result ? JSON.stringify(tc.result) : undefined;

  const argStr = formatArgs(tc.name, argsJson);
  const outsideKind = detectOutsideCwd(tc.name, argsJson);
  const isEdit = EDIT_TOOL_NAMES.has(tc.name);

  // Backend
  const backend = tc.result?.backend ?? null;
  const staticCategory = toolDisplay.category;
  const hasSplit = !!(backend && staticCategory && backend !== staticCategory);
  const category = hasSplit ? staticCategory : (backend ?? staticCategory);
  const backendTag = hasSplit ? backend : null;
  const categoryColor =
    (staticCategory ? CATEGORY_COLORS[staticCategory as ToolCategory] : null) ??
    (backend ? (CATEGORY_COLORS[backend as ToolCategory] ?? "#888") : undefined) ??
    "#888";
  const backendColorVal = backendTag
    ? (CATEGORY_COLORS[backendTag as ToolCategory] ?? "#888")
    : undefined;

  // Status
  const denied =
    !tc.result?.success &&
    !!(tc.result?.error && /denied|rejected|cancelled/i.test(tc.result.error));
  const isError = !!tc.result && !tc.result.success && !denied;
  const statusIcon = tc.result ? (tc.result.success ? "✓" : denied ? "⊘" : "✗") : "●";
  const statusColor = tc.result
    ? tc.result.success
      ? ROW_COLORS.checkDone
      : denied
        ? "#666"
        : ROW_COLORS.error
    : "#666";

  // Edit result text
  const editResultText =
    isEdit && tc.result?.success && resultJson ? formatResult(tc.name, resultJson) : undefined;

  // Suffix
  let suffix: string | undefined;
  let suffixColor: string | undefined;
  if (!editResultText && tc.result) {
    if (isError) {
      const fullError = tc.result.error ?? "";
      const clean = fullError.length > 60 ? `${fullError.slice(0, 57)}…` : fullError;
      suffix = ` → ${clean}`;
      suffixColor = "#a55";
    } else if (denied) {
      suffix = " → denied";
      suffixColor = "#666";
    } else if (!isEdit && resultJson) {
      const r = formatResult(tc.name, resultJson);
      if (r) suffix = ` → ${r}`;
    }
  }

  // Diff
  let diff: StaticToolRowProps["diff"] = null;
  if (
    tc.name === "edit_file" &&
    typeof tc.args.path === "string" &&
    typeof tc.args.oldString === "string" &&
    typeof tc.args.newString === "string"
  ) {
    let impact: string | undefined;
    if (tc.result?.success) {
      const m = tc.result.output.match(/\[impact: (.+)\]/);
      if (m?.[1]) impact = m[1];
    }
    diff = {
      path: tc.args.path as string,
      oldString: tc.args.oldString as string,
      newString: tc.args.newString as string,
      success: tc.result?.success ?? false,
      errorMessage: tc.result?.error,
      impact,
    };
  }

  return {
    statusContent: <span fg={statusColor}>{statusIcon} </span>,
    isDone: true,
    icon: toolDisplay.icon,
    iconColor: toolDisplay.iconColor,
    label: toolDisplay.label,
    category: category ?? undefined,
    categoryColor,
    backendTag: backendTag ?? undefined,
    backendColor: backendColorVal,
    outsideBadge: outsideKind ? OUTSIDE_BADGE[outsideKind] : null,
    argStr: argStr || undefined,
    editResultText,
    suffix,
    suffixColor,
    diff,
  };
}
