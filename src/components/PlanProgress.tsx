import { TextAttributes } from "@opentui/core";
import { icon } from "../core/icons.js";
import type { Task } from "../core/tools/task-list.js";
import type { Plan, PlanStepStatus } from "../types/index.js";
import { Spinner } from "./shared.js";
import { TaskList } from "./TaskProgress.js";

const STATUS_ICONS: Record<PlanStepStatus, () => string> = {
  done: () => icon("check"),
  active: () => "",
  pending: () => icon("spinner"),
  skipped: () => icon("skip"),
};

const STATUS_COLORS: Record<PlanStepStatus, string> = {
  done: "#4a7",
  active: "#9B30FF",
  pending: "#555",
  skipped: "#444",
};

const MAX_VISIBLE = 7;

interface Props {
  plan: Plan;
  tasks?: Task[];
}

export function PlanProgress({ plan, tasks }: Props) {
  const done = plan.steps.filter((s) => s.status === "done").length;
  const allDone = done === plan.steps.length;
  const hasTasks = tasks && tasks.length > 0;

  // Show a smart window: center on the active step, or show all if they fit
  let visibleSteps = plan.steps;
  let hiddenBefore = 0;
  let hiddenAfter = 0;

  if (plan.steps.length > MAX_VISIBLE && !allDone) {
    const activeIdx = plan.steps.findIndex((s) => s.status === "active");
    const centerIdx = activeIdx >= 0 ? activeIdx : done;
    const halfWindow = Math.floor(MAX_VISIBLE / 2);
    let start = Math.max(0, centerIdx - halfWindow);
    let end = start + MAX_VISIBLE;
    if (end > plan.steps.length) {
      end = plan.steps.length;
      start = Math.max(0, end - MAX_VISIBLE);
    }
    visibleSteps = plan.steps.slice(start, end);
    hiddenBefore = start;
    hiddenAfter = plan.steps.length - end;
  }

  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      border={true}
      borderColor={allDone ? "#4a7" : "#8B5CF6"}
      paddingX={1}
      width="100%"
    >
      <box gap={1} flexDirection="row">
        <text fg={allDone ? "#4a7" : "#8B5CF6"} attributes={TextAttributes.BOLD}>
          {icon("plan")} {plan.title}
        </text>
        <text fg="#555">
          {String(done)}/{String(plan.steps.length)}
        </text>
      </box>
      {hiddenBefore > 0 && <text fg="#444">{String(hiddenBefore)} completed above</text>}
      {visibleSteps.map((step) => (
        <box key={step.id} flexDirection="column">
          <box gap={1} flexDirection="row">
            {step.status === "active" ? (
              <Spinner />
            ) : (
              <text fg={STATUS_COLORS[step.status]}>{STATUS_ICONS[step.status]()}</text>
            )}
            <text
              fg={step.status === "active" ? "#eee" : STATUS_COLORS[step.status]}
              attributes={step.status === "active" ? TextAttributes.BOLD : undefined}
            >
              {step.label}
            </text>
          </box>
          {step.status === "active" && hasTasks && <TaskList tasks={tasks} nested />}
        </box>
      ))}
      {hiddenAfter > 0 && <text fg="#444">{String(hiddenAfter)} more pending</text>}
    </box>
  );
}
