import type { ToolResult } from "../../types/index.js";

export type TaskStatus = "pending" | "in-progress" | "done" | "blocked";

export interface Task {
  id: number;
  title: string;
  status: TaskStatus;
  created: number;
  updated: number;
}

let nextId = 1;
const tasks = new Map<number, Task>();

type TaskListAction = "add" | "update" | "remove" | "list" | "clear";

interface TaskListArgs {
  action: TaskListAction;
  title?: string;
  titles?: string[];
  id?: number;
  status?: TaskStatus;
}

type TaskChangeListener = (tasks: Task[]) => void;
const listeners = new Set<TaskChangeListener>();

export function onTaskChange(fn: TaskChangeListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  const snapshot = Array.from(tasks.values());
  for (const fn of listeners) fn(snapshot);
}

export function renderTaskList(): string | null {
  if (tasks.size === 0) return null;

  const statusIcon: Record<TaskStatus, string> = {
    pending: "○",
    "in-progress": "◐",
    done: "●",
    blocked: "✗",
  };

  const lines = ["## Active Tasks"];
  for (const t of tasks.values()) {
    lines.push(`${statusIcon[t.status]} [${String(t.id)}] ${t.title} (${t.status})`);
  }
  return lines.join("\n");
}

export function clearTasks(): void {
  tasks.clear();
  nextId = 1;
  notify();
}

export function resetInProgressTasks(): void {
  let changed = false;
  for (const task of tasks.values()) {
    if (task.status === "in-progress") {
      task.status = "pending";
      task.updated = Date.now();
      changed = true;
    }
  }
  if (changed) notify();
}

export function completeInProgressTasks(): void {
  let changed = false;
  for (const task of tasks.values()) {
    if (task.status === "in-progress") {
      task.status = "done";
      task.updated = Date.now();
      changed = true;
    }
  }
  if (changed) notify();
}

export const taskListTool = {
  name: "task_list",
  description: "Session task scratchpad. Actions: add, update, remove, list, clear.",
  execute: async (args: TaskListArgs): Promise<ToolResult> => {
    try {
      switch (args.action) {
        case "add": {
          const titlesToAdd = args.titles ?? (args.title ? [args.title] : []);
          if (titlesToAdd.length === 0) {
            return {
              success: false,
              output: "title or titles required for add",
              error: "missing title",
            };
          }
          const added: string[] = [];
          const now = Date.now();
          for (const title of titlesToAdd) {
            const id = nextId++;
            tasks.set(id, {
              id,
              title,
              status: args.status ?? "pending",
              created: now,
              updated: now,
            });
            added.push(`#${String(id)} ${title}`);
          }
          notify();
          return {
            success: true,
            output:
              added.length === 1
                ? `Task ${added[0]} added`
                : `${String(added.length)} tasks added:\n${added.join("\n")}`,
          };
        }

        case "update": {
          if (!args.id) {
            return { success: false, output: "id is required for update", error: "missing id" };
          }
          const task = tasks.get(args.id);
          if (!task) {
            return {
              success: false,
              output: `Task #${String(args.id)} not found`,
              error: "not found",
            };
          }
          if (args.status) task.status = args.status;
          if (args.title) task.title = args.title;
          task.updated = Date.now();
          notify();
          return {
            success: true,
            output: `Task #${String(task.id)}: ${task.title} → ${task.status}`,
          };
        }

        case "remove": {
          if (!args.id) {
            return { success: false, output: "id is required for remove", error: "missing id" };
          }
          const existed = tasks.delete(args.id);
          if (!existed) {
            return {
              success: false,
              output: `Task #${String(args.id)} not found`,
              error: "not found",
            };
          }
          notify();
          return { success: true, output: `Task #${String(args.id)} removed` };
        }

        case "list": {
          if (tasks.size === 0) {
            return { success: true, output: "No tasks." };
          }
          const lines: string[] = [];
          for (const t of tasks.values()) {
            lines.push(`#${String(t.id)} [${t.status}] ${t.title}`);
          }
          return { success: true, output: lines.join("\n") };
        }

        case "clear": {
          const count = tasks.size;
          tasks.clear();
          notify();
          return { success: true, output: `Cleared ${String(count)} task(s).` };
        }

        default: {
          const msg = `Unknown action: ${String(args.action)}. Use: add, update, remove, list, clear.`;
          return { success: false, output: msg, error: msg };
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: msg, error: msg };
    }
  },
};
