/**
 * Permission policy engine — auto-allow / auto-deny / ask routing.
 * Pure logic; no I/O. Consumed by the daemon to short-circuit socket prompts.
 */

import type { ChatBinding, PermissionRequest } from "./types.js";

export type PolicyDecision =
  | { kind: "allow"; matched: string }
  | { kind: "deny"; matched: string; reason: string }
  | { kind: "ask" };

const GLOB_STAR_TOKEN = "__HEARTH_STAR__";

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, GLOB_STAR_TOKEN)
    .replace(/\*/g, ".*")
    .replaceAll(GLOB_STAR_TOKEN, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function matchesAny(value: string, patterns: string[]): string | null {
  for (const pat of patterns) {
    try {
      if (globToRegex(pat).test(value)) return pat;
    } catch {}
  }
  return null;
}

/** Stringify tool input into the canonical matcher form: `ToolName(firstString)`. */
function toolSignature(req: PermissionRequest): string {
  const input = req.toolInput ?? {};
  const firstStr = Object.values(input).find((v): v is string => typeof v === "string");
  return `${req.toolName}(${firstStr ?? ""})`;
}

/** Matcher entry can be "toolName" or "toolName(glob)". */
function ruleMatches(req: PermissionRequest, rule: string): boolean {
  if (!rule) return false;
  const bareMatch = rule === req.toolName;
  if (bareMatch) return true;
  const sig = toolSignature(req);
  try {
    return globToRegex(rule).test(sig);
  } catch {
    return false;
  }
}

export function evaluatePolicy(
  req: PermissionRequest,
  binding: ChatBinding | null,
): PolicyDecision {
  const autoDeny = binding?.autoDeny ?? [];
  const autoApprove = binding?.autoApprove ?? [];

  for (const rule of autoDeny) {
    if (ruleMatches(req, rule)) {
      return { kind: "deny", matched: rule, reason: `auto-deny rule: ${rule}` };
    }
    // Also deny when the rule is a plain command substring match (e.g. "rm -rf *")
    const sig = toolSignature(req);
    if (matchesAny(sig, [rule])) {
      return { kind: "deny", matched: rule, reason: `auto-deny rule: ${rule}` };
    }
  }
  for (const rule of autoApprove) {
    if (ruleMatches(req, rule)) {
      return { kind: "allow", matched: rule };
    }
  }
  return { kind: "ask" };
}

export function describeTool(req: PermissionRequest): string {
  const input = req.toolInput ?? {};
  const path = (input.path ?? input.file ?? "") as string;
  const cmd = (input.command ?? input.script ?? "") as string;
  const cwd = req.cwd;
  const parts: string[] = [req.toolName];
  if (path) parts.push(`path=${path}`);
  if (cmd) parts.push(`cmd=${cmd.slice(0, 120)}`);
  if (cwd) parts.push(`cwd=${cwd}`);
  return parts.join(" · ");
}
