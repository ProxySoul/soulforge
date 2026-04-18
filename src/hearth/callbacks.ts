/**
 * Build the InteractiveCallbacks object that the Forge agent consumes.
 * Each callback serialises the prompt through the surface and awaits the
 * user's reply. No callback ever throws — failure defaults to safe (deny/skip).
 */

import type {
  InteractiveCallbacks,
  Plan,
  PlanReviewAction,
  PlanStepStatus,
} from "../types/index.js";
import type { ExternalChatId, Surface } from "./types.js";

export interface CallbacksCtx {
  surface: Surface;
  externalId: ExternalChatId;
  tabId: string;
  /** Optional logger for daemon telemetry. */
  log?: (line: string) => void;
}

function safeNotify(ctx: CallbacksCtx, msg: string): void {
  ctx.surface.notify(ctx.externalId, msg).catch((err) => {
    ctx.log?.(`notify failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

export function buildHearthCallbacks(ctx: CallbacksCtx): InteractiveCallbacks {
  return {
    onPlanCreate(plan: Plan): void {
      safeNotify(ctx, `📋 Plan: ${plan.title} (${plan.steps.length} step(s))`);
    },
    onPlanStepUpdate(stepId: string, status: PlanStepStatus): void {
      safeNotify(ctx, `• ${stepId} → ${status}`);
    },
    async onPlanReview(
      plan: Plan,
      _planFile: string,
      _planContent: string,
    ): Promise<PlanReviewAction> {
      safeNotify(
        ctx,
        `🧭 Plan ready: ${plan.title}. Reply /approve to execute or /deny to cancel.`,
      );
      // Plan review in Hearth resolves via /approve or /deny commands intercepted by the daemon.
      // Default to "cancel" — daemon overrides when the command arrives.
      return "cancel";
    },
    async onAskUser(question: string, options, _allowSkip): Promise<string> {
      const lines = [question, ...options.map((o, i) => `${String(i + 1)}. ${o.label}`)];
      safeNotify(ctx, lines.join("\n"));
      // Daemon overrides this promise when the user replies. Returning "" lets
      // Forge continue with no answer when the surface is unreachable.
      return "";
    },
    async onOpenEditor(_file?: string): Promise<void> {
      safeNotify(ctx, "Editor is not available on remote surfaces.");
    },
    async onWebSearchApproval(query: string): Promise<boolean> {
      try {
        const { decision } = await ctx.surface.requestApproval(ctx.externalId, {
          approvalId: `web:${Date.now().toString(36)}`,
          toolName: "web_search",
          summary: `Web search: ${query.slice(0, 100)}`,
          cwd: "",
          tabId: ctx.tabId,
        });
        return decision === "allow";
      } catch {
        return false;
      }
    },
    async onFetchPageApproval(url: string): Promise<boolean> {
      try {
        const { decision } = await ctx.surface.requestApproval(ctx.externalId, {
          approvalId: `fetch:${Date.now().toString(36)}`,
          toolName: "fetch_page",
          summary: `Fetch page: ${url.slice(0, 120)}`,
          cwd: "",
          tabId: ctx.tabId,
        });
        return decision === "allow";
      } catch {
        return false;
      }
    },
  };
}
