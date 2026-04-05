import { TextAttributes } from "@opentui/core";
import { type ThemeTokens, useTheme } from "../../core/theme/index.js";
import type { PlanOutput } from "../../types/index.js";

function getActionColors(t: ThemeTokens): Record<string, string> {
  return { create: t.success, modify: t.amber, delete: t.error };
}
const ACTION_ICONS: Record<string, string> = {
  create: "+",
  modify: "~",
  delete: "-",
};
function getSymbolActionColors(t: ThemeTokens): Record<string, string> {
  return { add: t.success, modify: t.amber, remove: t.error, rename: t.info };
}

const MAX_VISIBLE = 5;

interface Props {
  plan: PlanOutput;
  result?: string;
  planFile?: string;
  collapsed?: boolean;
}

export function StructuredPlanView({ plan, result, planFile, collapsed }: Props) {
  const t = useTheme();
  const BORDER = t.textFaint;
  const TITLE_COLOR = t.info;
  const SECTION_COLOR = t.brandAlt;
  const FILE_PATH_COLOR = t.textPrimary;
  const STEP_NUM_COLOR = t.brandAlt;
  const TEXT_COLOR = t.textSecondary;
  const CHECK_COLOR = t.success;
  const { files, steps, verification, context } = plan;

  let resolvedFile = planFile;
  if (!resolvedFile && result) {
    try {
      const parsed = JSON.parse(result);
      if (typeof parsed.file === "string") resolvedFile = parsed.file as string;
    } catch {
      // result may not be JSON
    }
  }

  const isCancelled = result?.includes("cancelled by user");
  const isRevised = result?.startsWith("User wants changes to the plan:");
  const reviseFeedback =
    isRevised && result ? result.replace("User wants changes to the plan: ", "") : null;
  const isRejected = isCancelled || isRevised;

  const borderColor = isRejected ? t.textSubtle : BORDER;
  const titleColor = isRejected ? t.textMuted : TITLE_COLOR;

  if (collapsed) {
    const files = plan.files ?? [];
    const steps = plan.steps ?? [];
    return (
      <box height={1} flexShrink={0}>
        <text truncate>
          <span fg={CHECK_COLOR}>{"✓ "}</span>
          <span fg={TITLE_COLOR} attributes={TextAttributes.BOLD}>
            {plan.title}
          </span>
          <span fg={t.textMuted}>
            {" "}
            ({String(files.length)} file{files.length !== 1 ? "s" : ""}, {String(steps.length)} step
            {steps.length !== 1 ? "s" : ""})
          </span>
          {resolvedFile ? (
            <>
              <span fg={t.textFaint}> ─ </span>
              <span fg={t.textMuted}>{resolvedFile}</span>
            </>
          ) : null}
        </text>
      </box>
    );
  }

  if (isRejected) {
    return (
      <box
        flexDirection="column"
        flexShrink={0}
        border
        borderStyle="rounded"
        borderColor={borderColor}
      >
        <box
          height={1}
          flexShrink={0}
          paddingX={1}
          backgroundColor={t.bgSecondary}
          alignSelf="flex-start"
          marginTop={-1}
        >
          <text truncate>
            <span fg={titleColor}>{"\uF0CB"}</span>{" "}
            <span fg={titleColor} attributes={TextAttributes.BOLD}>
              {plan.title}
            </span>
            {resolvedFile ? (
              <>
                <span fg={t.textFaint}> ─ </span>
                <span fg={t.textDim}>{resolvedFile}</span>
              </>
            ) : null}
          </text>
        </box>
        <box paddingX={1}>
          {isCancelled ? (
            <text fg={t.error}>✗ Plan cancelled</text>
          ) : (
            <text>
              <span fg={t.warning}>↻ Revision requested: </span>
              <span fg={t.textSecondary}>{reviseFeedback}</span>
            </text>
          )}
        </box>
      </box>
    );
  }

  return (
    <box flexDirection="column" flexShrink={0} border borderStyle="rounded" borderColor={BORDER}>
      <box
        height={1}
        flexShrink={0}
        paddingX={1}
        backgroundColor={t.bgSecondary}
        alignSelf="flex-start"
        marginTop={-1}
      >
        <text truncate>
          <span fg={TITLE_COLOR}>{"\uF0CB"}</span>{" "}
          <span fg={TITLE_COLOR} attributes={TextAttributes.BOLD}>
            {plan.title}
          </span>
          {resolvedFile ? (
            <>
              <span fg={t.textFaint}> ─ </span>
              <span fg={t.textMuted}>{resolvedFile}</span>
            </>
          ) : null}
        </text>
      </box>

      {context && (
        <box flexDirection="column" paddingX={1}>
          <text fg={SECTION_COLOR} attributes={TextAttributes.BOLD}>
            Context
          </text>
          {context.split("\n").map((line, i) => (
            <text key={`ctx-${String(i)}`} fg={TEXT_COLOR}>
              {line}
            </text>
          ))}
        </box>
      )}

      {files.length > 0 && (
        <box flexDirection="column" paddingX={1} marginTop={context ? 1 : 0}>
          <text>
            <span fg={SECTION_COLOR} attributes={TextAttributes.BOLD}>
              Files
            </span>
            <span fg={t.textMuted}> ({String(files.length)})</span>
          </text>
          {files.slice(0, MAX_VISIBLE).map((f) => (
            <box key={f.path} flexDirection="column">
              <text>
                <span fg={getActionColors(t)[f.action] ?? t.textSecondary}>
                  {ACTION_ICONS[f.action] ?? "?"}{" "}
                </span>
                <span fg={FILE_PATH_COLOR}>{f.path}</span>
              </text>
              <text fg={t.textMuted}>
                {"   "}
                {f.description}
              </text>
              {f.symbols?.map((s, si) => (
                <text key={`${f.path}-s${String(si)}`} fg={t.textMuted}>
                  {"     "}
                  <span fg={getSymbolActionColors(t)[s.action] ?? t.textSecondary}>{s.action}</span>{" "}
                  <span fg={t.textSecondary}>{s.name}</span>
                  <span fg={t.textMuted}> ({s.kind})</span>
                </text>
              ))}
            </box>
          ))}
          {files.length > MAX_VISIBLE && (
            <text fg={t.textMuted}>+{String(files.length - MAX_VISIBLE)} more</text>
          )}
        </box>
      )}

      {steps.length > 0 && (
        <box flexDirection="column" paddingX={1} marginTop={files.length > 0 || context ? 1 : 0}>
          <text>
            <span fg={SECTION_COLOR} attributes={TextAttributes.BOLD}>
              Steps
            </span>
            <span fg={t.textMuted}> ({String(steps.length)})</span>
          </text>
          {steps.slice(0, MAX_VISIBLE).map((s, i) => (
            <text key={s.id}>
              <span fg={STEP_NUM_COLOR}>{String(i + 1)}. </span>
              <span fg={TEXT_COLOR}>{s.label}</span>
            </text>
          ))}
          {steps.length > MAX_VISIBLE && (
            <text fg={t.textMuted}>+{String(steps.length - MAX_VISIBLE)} more</text>
          )}
        </box>
      )}

      {verification.length > 0 && (
        <box flexDirection="column" paddingX={1} marginTop={1}>
          <text fg={SECTION_COLOR} attributes={TextAttributes.BOLD}>
            Verification
          </text>
          {verification.map((v, i) => (
            <text key={`v-${String(i)}`}>
              <span fg={CHECK_COLOR}>{"✓ "}</span>
              <span fg={TEXT_COLOR}>{v}</span>
            </text>
          ))}
        </box>
      )}
    </box>
  );
}
