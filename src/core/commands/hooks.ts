import { useUIStore } from "../../stores/ui.js";
import { loadHooks } from "../hooks/loader.js";
import { disableHookEvent, enableHookEvent, isHookEventDisabled } from "../hooks/runner.js";
import type { CommandHook, HookEventName, HookRule } from "../hooks/types.js";
import { icon } from "../icons.js";
import { getThemeTokens } from "../theme/index.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";

/** Build a compact summary for a hook event — only show tags that differentiate. */
function summarizeRules(rules: HookRule[]): string {
  let count = 0;
  let syncCount = 0;
  let hasMatcher = false;
  let hasOnce = false;
  for (const rule of rules) {
    count += rule.hooks.length;
    if (rule.matcher && rule.matcher !== "*") hasMatcher = true;
    for (const h of rule.hooks) {
      const hook = h as CommandHook;
      if (!hook.async) syncCount++;
      if (hook.once) hasOnce = true;
    }
  }
  const tags: string[] = [`${count} cmd${count !== 1 ? "s" : ""}`];
  if (syncCount > 0) tags.push("blocking");
  if (hasMatcher) tags.push("filtered");
  if (hasOnce) tags.push("once");
  return tags.join(", ");
}

function handleHooks(_input: string, ctx: CommandContext): void {
  const hooks = loadHooks(ctx.cwd);
  const t = getThemeTokens();

  const events = Object.entries(hooks) as [HookEventName, HookRule[]][];

  if (events.length === 0) {
    ctx.openInfoPopup({
      title: "Hooks",
      icon: icon("cog"),
      lines: [
        { type: "text", label: "No hooks configured." },
        { type: "spacer" },
        { type: "text", label: "Add hooks to:", color: t.textDim },
        { type: "text", label: "  .claude/settings.json", color: t.textMuted },
        { type: "text", label: "  .soulforge/config.json", color: t.textMuted },
      ],
    });
    return;
  }

  const buildOptions = () =>
    events.map(([event, rules]) => {
      const enabled = !isHookEventDisabled(event);
      const summary = summarizeRules(rules);
      const status = enabled ? "" : " · disabled";
      return {
        value: event,
        icon: enabled ? icon("success") : icon("ban"),
        color: enabled ? t.success : t.textDim,
        label: `${event}  ${summary}${status}`,
      };
    });

  ctx.openCommandPicker({
    title: "Hooks",
    icon: icon("cog"),
    keepOpen: true,
    currentValue: "",
    options: buildOptions(),
    onSelect: (value) => {
      const event = value as HookEventName;
      if (isHookEventDisabled(event)) {
        enableHookEvent(event);
        sysMsg(ctx, `Hook "${event}" enabled`);
      } else {
        disableHookEvent(event);
        sysMsg(ctx, `Hook "${event}" disabled (session only)`);
      }
      useUIStore.getState().updatePickerOptions(buildOptions());
    },
  });
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/hooks", handleHooks);
}
