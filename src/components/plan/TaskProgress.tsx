import { TextAttributes } from "@opentui/core";
import { useEffect, useState } from "react";
import { icon } from "../../core/icons.js";
import { onTaskChange, type Task, type TaskStatus } from "../../core/tools/task-list.js";
import { SPINNER_FRAMES, useSpinnerFrame } from "../layout/shared.js";

const STATUS_ICONS: Record<TaskStatus, string> = {
  done: "✓",
  "in-progress": "",
  pending: "○",
  blocked: "✗",
};

const STATUS_COLORS: Record<TaskStatus, string> = {
  done: "#4a7",
  "in-progress": "#9B30FF",
  pending: "#555",
  blocked: "#f44",
};

const MAX_VISIBLE = 6;

interface TaskListProps {
  tasks: Task[];
  nested?: boolean;
}

function InlineSpinner({ color }: { color: string }) {
  const frame = useSpinnerFrame();
  return <span fg={color}>{SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}</span>;
}

export function TaskList({ tasks, nested }: TaskListProps) {
  if (tasks.length === 0) return null;

  const doneTasks = tasks.filter((t) => t.status === "done");
  const activeTasks = tasks.filter((t) => t.status === "in-progress");
  const pendingTasks = tasks.filter((t) => t.status === "pending" || t.status === "blocked");
  const nonDone = [...activeTasks, ...pendingTasks];

  const renderTask = (task: Task) => (
    <box key={String(task.id)} height={1} flexDirection="row">
      <text>
        {task.status === "in-progress" ? (
          <InlineSpinner color={STATUS_COLORS["in-progress"]} />
        ) : (
          <span fg={STATUS_COLORS[task.status]}>{STATUS_ICONS[task.status]}</span>
        )}
        <span> </span>
        <span
          fg={
            task.status === "done"
              ? "#666"
              : task.status === "in-progress"
                ? "#eee"
                : STATUS_COLORS[task.status]
          }
          attributes={task.status === "in-progress" ? TextAttributes.BOLD : undefined}
        >
          {task.title}
        </span>
      </text>
    </box>
  );

  if (nested) {
    return (
      <box flexDirection="column" paddingLeft={2}>
        {doneTasks.length > 0 && <text fg="#4a7"> +{String(doneTasks.length)} done</text>}
        {nonDone.slice(0, MAX_VISIBLE).map(renderTask)}
        {nonDone.length > MAX_VISIBLE && (
          <text fg="#555"> +{String(nonDone.length - MAX_VISIBLE)} more</text>
        )}
      </box>
    );
  }

  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      border={true}
      borderColor="#336"
      paddingX={1}
      width="100%"
    >
      <box gap={1} flexDirection="row" height={1}>
        <text fg="#336" attributes={TextAttributes.BOLD}>
          {icon("plan")} Tasks
        </text>
        <text fg="#555">
          {String(doneTasks.length)}/{String(tasks.length)}
        </text>
      </box>
      {doneTasks.length > 0 && <text fg="#4a7">+{String(doneTasks.length)} done</text>}
      {nonDone.slice(0, MAX_VISIBLE).map(renderTask)}
      {nonDone.length > MAX_VISIBLE && (
        <text fg="#555">+{String(nonDone.length - MAX_VISIBLE)} more</text>
      )}
    </box>
  );
}

export function TaskProgress() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [visible, setVisible] = useState(false);

  useEffect(() => onTaskChange(setTasks), []);

  useEffect(() => {
    if (tasks.length === 0) {
      setVisible(false);
      return;
    }
    const actionable = tasks.some((t) => t.status === "pending" || t.status === "in-progress");
    if (actionable) {
      setVisible(true);
      return;
    }
    // All done/blocked — linger then dismiss
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), 3000);
    return () => clearTimeout(timer);
  }, [tasks]);

  if (!visible) return null;

  return <TaskList tasks={tasks} />;
}

export function useTaskList(): Task[] {
  const [tasks, setTasks] = useState<Task[]>([]);
  useEffect(() => onTaskChange(setTasks), []);
  return tasks;
}
