import type { ToolResult } from "../../types/index.js";

/**
 * Construct a failed ToolResult where output and error share the same message.
 */
export function toolError(msg: string): ToolResult {
  return { success: false, output: msg, error: msg };
}

/**
 * Construct a denied ToolResult (e.g. forbidden path, unapproved action).
 */
export function toolDenied(msg: string): ToolResult {
  return { success: false, output: msg, error: msg };
}

/**
 * Construct a successful ToolResult.
 */
export function toolOk(output: string, extra?: Partial<ToolResult>): ToolResult {
  return { success: true, output, ...extra };
}

/**
 * Wrap a function body in a try/catch that returns a ToolResult on error.
 * Eliminates the repeated `catch (err: unknown) { return { success: false, output: String(err), error: String(err) }; }` pattern.
 */
export async function catchToolError(
  fn: () => Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err: unknown) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
}
