/**
 * Log-redaction middleware — scrubs common credential shapes from any string
 * before it reaches a sink (stderr, log file, surface message).
 *
 * Covers CVE-2026-27003 (Telegram bot token leak via unredacted logs) and
 * CVE-2026-32982 (bot token in failed media-download URLs). Extended with
 * generic patterns for provider API keys, OAuth bearers, GitHub tokens,
 * Slack tokens, AWS access keys.
 *
 * Pure functions — no side effects. `installGlobalRedaction()` opts into
 * wrapping process.stderr.write and process.stdout.write (daemon only).
 */

export interface RedactionRule {
  /** Human label for the kind of secret (shown in telemetry, never the secret itself). */
  kind: string;
  /** Regex with a capture group for the secret. Full match is replaced. */
  pattern: RegExp;
  /** Replacement template. Use $1 to keep a visible prefix. */
  replacement: string;
}

/**
 * Built-in rules. Order matters — more specific patterns first so they win
 * before generic bearer/hex fallbacks.
 */
export const DEFAULT_REDACTION_RULES: RedactionRule[] = [
  // Telegram bot token: `123456:AAA-BBB...`
  { kind: "telegram-bot", pattern: /\b(\d{6,12}):([A-Za-z0-9_-]{30,})\b/g, replacement: "$1:***" },
  // Discord bot token: three dot-separated base64 segments
  {
    kind: "discord-bot",
    pattern: /\b([A-Za-z0-9_-]{20,30})\.([A-Za-z0-9_-]{6,8})\.([A-Za-z0-9_-]{20,40})\b/g,
    replacement: "$1.***",
  },
  // OpenAI / Anthropic style: sk-... / sk-ant-...
  { kind: "openai", pattern: /\b(sk-[A-Za-z0-9_-]{20,})\b/g, replacement: "sk-***" },
  { kind: "anthropic", pattern: /\b(sk-ant-[A-Za-z0-9_-]{20,})\b/g, replacement: "sk-ant-***" },
  // GitHub classic + fine-grained + OAuth
  { kind: "github", pattern: /\b(gh[pousr]_[A-Za-z0-9]{30,})\b/g, replacement: "ghx_***" },
  {
    kind: "github-fg",
    pattern: /\b(github_pat_[A-Za-z0-9_]{60,})\b/g,
    replacement: "github_pat_***",
  },
  // Slack
  {
    kind: "slack",
    pattern: /\b(xox[abprs]-[A-Za-z0-9-]{10,})\b/g,
    replacement: "xoxx-***",
  },
  // AWS access key ids (keep 4 prefix so we can tell "was leaked" apart)
  { kind: "aws-access-key", pattern: /\b(AKIA[0-9A-Z]{16})\b/g, replacement: "AKIA***" },
  // Bearer tokens in Authorization headers
  {
    kind: "bearer",
    pattern: /\b(Bearer)\s+([A-Za-z0-9._-]{20,})\b/g,
    replacement: "Bearer ***",
  },
  // Long hex-encoded secrets (128+ chars = 64 bytes) — catches raw HMAC keys and
  // session tokens while leaving normal 40-char git hashes and 64-char SHA-256 sums
  // of non-secret file content untouched.
  {
    kind: "long-hex",
    pattern: /\b([a-f0-9]{128,})\b/g,
    replacement: "***",
  },
];

let _rules: RedactionRule[] = [...DEFAULT_REDACTION_RULES];
let _installed = false;

/** Replace the active rule set (tests, custom policies). */
export function setRedactionRules(rules: RedactionRule[]): void {
  _rules = rules;
}

/** Append rules without replacing defaults. */
export function addRedactionRules(rules: RedactionRule[]): void {
  _rules = [..._rules, ...rules];
}

/** Get a snapshot of active rules. */
export function getRedactionRules(): readonly RedactionRule[] {
  return _rules;
}

/** Redact a string. Returns the scrubbed string — never throws. */
export function redact(input: string): string {
  if (!input) return input;
  let out = input;
  for (const rule of _rules) {
    // Reset lastIndex defensively — shared regex state in global scope
    rule.pattern.lastIndex = 0;
    out = out.replace(rule.pattern, rule.replacement);
  }
  return out;
}

/** Redact any value by round-tripping through JSON when needed. */
export function redactUnknown(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") return redact(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactUnknown(v);
    return out;
  }
  return value;
}

/** Test helper — report which rules matched an input (kind only, never the secret). */
export function auditRedaction(input: string): { kind: string; count: number }[] {
  const hits: { kind: string; count: number }[] = [];
  for (const rule of _rules) {
    rule.pattern.lastIndex = 0;
    const matches = input.match(rule.pattern);
    if (matches && matches.length > 0) hits.push({ kind: rule.kind, count: matches.length });
  }
  return hits;
}

type WriteFn = (chunk: unknown, encoding?: unknown, cb?: unknown) => boolean;

interface OriginalWriters {
  stdout: WriteFn;
  stderr: WriteFn;
}

let _original: OriginalWriters | null = null;

function wrapWriter(orig: WriteFn): WriteFn {
  return function wrapped(
    this: unknown,
    chunk: unknown,
    encoding?: unknown,
    cb?: unknown,
  ): boolean {
    try {
      if (typeof chunk === "string") {
        return orig.call(this, redact(chunk), encoding as never, cb as never);
      }
      if (chunk && typeof chunk === "object" && chunk instanceof Uint8Array) {
        const s = Buffer.from(chunk).toString("utf-8");
        const scrubbed = redact(s);
        if (scrubbed !== s) {
          return orig.call(this, Buffer.from(scrubbed, "utf-8"), encoding as never, cb as never);
        }
      }
    } catch {}
    return orig.call(this, chunk as never, encoding as never, cb as never);
  } as WriteFn;
}

/**
 * Wrap process.stdout.write and process.stderr.write so all emitted bytes are
 * scrubbed through the active rule set. Idempotent — safe to call multiple times.
 * Daemon-only; CLI runs raw.
 */
export function installGlobalRedaction(): void {
  if (_installed) return;
  _original = {
    stdout: process.stdout.write.bind(process.stdout) as WriteFn,
    stderr: process.stderr.write.bind(process.stderr) as WriteFn,
  };
  process.stdout.write = wrapWriter(_original.stdout) as typeof process.stdout.write;
  process.stderr.write = wrapWriter(_original.stderr) as typeof process.stderr.write;
  _installed = true;
}

/** Unwrap writers — for tests and clean daemon shutdown. */
export function uninstallGlobalRedaction(): void {
  if (!_installed || !_original) return;
  process.stdout.write = _original.stdout as typeof process.stdout.write;
  process.stderr.write = _original.stderr as typeof process.stderr.write;
  _original = null;
  _installed = false;
}

export function isRedactionInstalled(): boolean {
  return _installed;
}
