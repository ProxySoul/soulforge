import type { ReadTracker } from "./read-tracker.js";

const READ_TRACKER_CHECK_TOOLS = new Set([
  "read_file",
  "read_code",
  "grep",
  "soul_grep",
  "glob",
  "soul_find",
  "navigate",
  "soul_analyze",
  "soul_impact",
]);

export function wrapToolsWithReadTracker(
  tools: Record<string, unknown>,
  tracker: ReadTracker,
): void {
  const stepCounter = { value: 0 };

  for (const [name, t] of Object.entries(tools)) {
    if (!READ_TRACKER_CHECK_TOOLS.has(name)) continue;
    // biome-ignore lint/suspicious/noExplicitAny: AI SDK tool types are opaque; wrapping execute requires runtime duck-typing
    const aiTool = t as { execute?: (...a: any[]) => any };
    if (!aiTool?.execute) continue;

    const origExecute = aiTool.execute;
    // biome-ignore lint/suspicious/noExplicitAny: wrapping opaque SDK tool execute
    aiTool.execute = async (...executeArgs: any[]) => {
      stepCounter.value++;
      const args = (executeArgs[0] ?? {}) as Record<string, unknown>;
      const block = tracker.check(name, args, stepCounter.value);
      if (block) return { success: true, output: block };
      const result = await origExecute(...executeArgs);
      const isOutlineOnly = result && typeof result === "object" && result.outlineOnly === true;
      if (!isOutlineOnly) {
        tracker.record(name, args, stepCounter.value, `s${String(stepCounter.value)}`);
      }
      return result;
    };
  }
}
