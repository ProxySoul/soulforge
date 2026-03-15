/**
 * Bus tools — extra tools given to subagents when running in a multi_agent dispatch.
 * These let agents communicate findings to peers via the shared AgentBus.
 */

import { tool } from "ai";
import { z } from "zod";
import type { AgentBus } from "./agent-bus.js";

/**
 * Build coordination tools for a specific agent on the bus.
 * @param role — "explore" agents skip edit-conflict tools, "code" agents skip files-read tools
 */
export function buildBusTools(bus: AgentBus, agentId: string, role?: import("./agent-bus.js").AgentRole) {
  return {
    report_finding: tool({
      description:
        "Report a finding to peer agents running in parallel. " +
        "Use this when you discover something important that other agents should know about — " +
        "file locations, architectural patterns, relevant code, key decisions, etc. " +
        "Peers can read your findings in real-time.",
      inputSchema: z.object({
        label: z
          .string()
          .describe("Short label for the finding (e.g. 'Config location', 'API pattern')"),
        content: z
          .string()
          .describe("Detailed content — code snippets, file paths, analysis, etc."),
      }),
      execute: async (args) => {
        bus.postFinding({
          agentId,
          label: args.label,
          content: args.content,
          timestamp: Date.now(),
        });
        return {
          success: true,
          output: `Finding "${args.label}" shared with ${bus.findingCount - 1} other finding(s) on the bus.`,
        };
      },
    }),

    check_findings: tool({
      description:
        "Check findings reported by peer agents running in parallel. " +
        "Use this to see what other agents have discovered so far. " +
        "Returns all findings from peers, or findings from a specific peer agent.",
      inputSchema: z.object({
        peerId: z
          .string()
          .optional()
          .describe("Specific peer agent ID to check (omit for all peers)"),
      }),
      execute: async (args) => {
        const findings = args.peerId ? bus.getPeerFindings(args.peerId) : bus.getFindings(agentId);

        if (findings.length === 0) {
          return { success: true, output: "No findings from peers yet." };
        }

        const summary = findings
          .map((f) => `[${f.agentId}] ${f.label}:\n${f.content}`)
          .join("\n\n---\n\n");

        return { success: true, output: summary };
      },
    }),

    check_peers: tool({
      description:
        "See peer agents — their ID, role, task, and live status (running/completed/errored).",
      inputSchema: z.object({}),
      execute: async () => {
        const peers = bus.tasks.filter((t) => t.agentId !== agentId);
        if (peers.length === 0) {
          return { success: true, output: "No peer agents in this dispatch." };
        }
        const lines = peers.map((t) => {
          const result = bus.getResult(t.agentId);
          let status = "running";
          if (result) status = result.success ? "completed" : "errored";
          return `[${t.agentId}] (${t.role}) ${status} — ${t.task}`;
        });
        return { success: true, output: lines.join("\n") };
      },
    }),

    check_agent_result: tool({
      description:
        "Get a completed peer agent's final result. " +
        "Use when you need a peer's conclusion, not just interim findings.",
      inputSchema: z.object({
        peerId: z.string().describe("The agent ID to check"),
      }),
      execute: async (args) => {
        const result = bus.getResult(args.peerId);
        if (!result) {
          return {
            success: true,
            output: `Agent "${args.peerId}" has not completed yet.`,
          };
        }
        return {
          success: true,
          output: `[${args.peerId}] (${result.role}) ${result.success ? "✓" : "✗"}:\n${result.result}`,
        };
      },
    }),

    ...(role !== "explore"
      ? {
          check_edit_conflicts: tool({
            description:
              "See file ownership — which files are claimed by which agent. " +
              "The first agent to edit a file owns it. Edits to owned files are serialized via a mutex. " +
              "If you need changes in a file owned by another agent, use report_finding to describe the edit and let the owner apply it.",
            inputSchema: z.object({}),
            execute: async () => {
              const edited = bus.getEditedFiles();
              const entries: string[] = [];
              for (const [path, editors] of edited) {
                const owner = bus.getFileOwner(path);
                const ownerTag = owner === agentId ? "(you)" : `(owner: ${owner})`;
                entries.push(`${path} ${ownerTag} — editors: ${editors.join(", ")}`);
              }
              if (entries.length === 0) {
                return { success: true, output: "No files edited by any agent yet." };
              }
              return { success: true, output: entries.join("\n") };
            },
          }),
        }
      : {}),

    cancel_dispatch: tool({
      description:
        "Cancel the entire dispatch — all peer agents will be aborted. " +
        "Use ONLY when you discover the task is fundamentally impossible or the approach is wrong " +
        "and continuing would waste resources. Always report_finding with the reason first.",
      inputSchema: z.object({
        reason: z.string().describe("Why the dispatch should be cancelled"),
      }),
      execute: async (args) => {
        bus.postFinding({
          agentId,
          label: "DISPATCH CANCELLED",
          content: args.reason,
          timestamp: Date.now(),
        });
        bus.abort(args.reason);
        return { success: true, output: `Dispatch cancelled: ${args.reason}` };
      },
    }),
  };
}
