import { DIM, PURPLE, RED, RST, YELLOW } from "./constants.js";

export function writeEvent(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

export function stderrLabel(label: string, value: string): void {
  process.stderr.write(`${PURPLE}${label}:${RST} ${value}\n`);
}

export function stderrDim(msg: string): void {
  process.stderr.write(`${DIM}${msg}${RST}\n`);
}

export function stderrError(msg: string): void {
  process.stderr.write(`${RED}Error:${RST} ${msg}\n`);
}

export function stderrWarn(msg: string): void {
  process.stderr.write(`${YELLOW}${msg}${RST}\n`);
}

export function separator(): void {
  process.stderr.write(`${DIM}${"─".repeat(40)}${RST}\n`);
}

export function formatTokens(tokens: { input: number; output: number; cacheRead: number }): string {
  const inK = (tokens.input / 1000).toFixed(1);
  const outK = (tokens.output / 1000).toFixed(1);
  const cachePct = tokens.input > 0 ? Math.round((tokens.cacheRead / tokens.input) * 100) : 0;
  const cacheStr = tokens.cacheRead > 0 ? `, ${String(cachePct)}% cached` : "";
  return `${inK}k in, ${outK}k out${cacheStr}`;
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${String(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
