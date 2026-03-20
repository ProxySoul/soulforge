/**
 * Language-agnostic shell output compression.
 *
 * Reduces token waste from test runners, build tools, and linters
 * without losing actionable information. Works by detecting structural
 * patterns in output (repeated lines, stack frames, progress indicators)
 * rather than language-specific keywords.
 */

/** Collapse consecutive lines matching the same normalized pattern into a count.
 *  Skips stack frames and summary lines (already handled by the main pass). */
function collapseRepeated(lines: string[]): string[] {
  const out: string[] = [];
  let repeatPattern: string | null = null;
  let repeatCount = 0;

  const flush = () => {
    if (repeatCount > 1) {
      out.push(`  ... ${String(repeatCount - 1)} more similar lines`);
    }
    repeatPattern = null;
    repeatCount = 0;
  };

  for (const line of lines) {
    // Don't collapse stack frames or our own summary markers
    if (
      STACK_FRAME_RE.test(line) ||
      (line.includes("... ") && (line.includes("more frames") || line.includes("omitted")))
    ) {
      if (repeatCount > 0) flush();
      out.push(line);
      repeatPattern = null;
      repeatCount = 0;
      continue;
    }
    const normalized = line.replace(/^\s*\d{1,4}[:.)\]|]\s*/, "").replace(/\d+/g, "N");
    if (repeatPattern !== null && normalized === repeatPattern) {
      repeatCount++;
      continue;
    }
    if (repeatCount > 0) flush();
    out.push(line);
    repeatPattern = normalized;
    repeatCount = 1;
  }
  if (repeatCount > 1) flush();
  return out;
}

// Stack frame patterns across languages (structural, not keyword-based):
// JS/TS:      "    at Function.name (file:line:col)"
// Python:     '  File "path", line N, in func'
// Java/Kotlin:"	at com.package.Class.method(File.java:123)"
// Rust:       "   N: std::panic::..." or "             at /path/src/main.rs:42:5"
// Ruby:       "	from /path/to/file.rb:123:in `method'"
// C#:         "   at Namespace.Class.Method() in /path/File.cs:line 42"
// Go:         "	/path/to/file.go:123 +0x1a4"
const STACK_FRAME_RE =
  /^\s+at\s+|^\s+File\s+"[^"]+",\s+line\s+\d+|^\s+at\s+[\w.$]+\(|^\s+\d+:\s+\w|^\s+from\s+\//;

// Passing test indicators across test runners:
// - JS (jest/vitest): "  ✓ test name" or "  ✔ test name"
// - Python (pytest): "tests/foo.py::test_name PASSED"
// - Go: "--- PASS: TestName"  or "ok  	package	0.003s"
// - Rust: "test foo::bar ... ok"
// - Ruby (rspec): "  ." (dots for passing)
// - TAP format: "ok 1 - test description"
// - Java (gradle/maven): "✓ test_name()" or "Tests run: 5, Failures: 0"
const PASS_LINE_RE =
  /^[\s✓✔√●∙·►▸▹]+\s*(PASS|pass|ok|OK|✓|✔|√)\s|^\s*(PASS|ok)\s+[\w/.-]+|^ok\s+\d+\s|PASSED\s*$|^---\s*PASS:|^test\s+\S+\s+\.\.\.\s+ok\s*$/;

// Progress bars, spinners, download indicators
const NOISE_RE =
  /^\s*[\\/|─━░▓█▒■□◻◼⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]+\s*$|^\s*\d+%\s*[|█▓░]+|^(Downloading|Fetching|Installing|Resolving|Compiling)\b.*\.\.\./;

const MAX_STACK_FRAMES = 5;
const MAX_PASS_LINES = 3;

export interface CompressResult {
  text: string;
  /** The original uncompressed text, only set when compression removed significant content. */
  original: string | null;
}

export function compressShellOutput(raw: string): string {
  return compress(raw).text;
}

export function compressShellOutputFull(raw: string): CompressResult {
  return compress(raw);
}

function compress(raw: string): CompressResult {
  const lines = raw.split("\n");
  if (lines.length < 20) return { text: raw, original: null };

  const out: string[] = [];
  let stackFrames = 0;
  let inStack = false;
  let passLines = 0;
  let totalPassSuppressed = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;

    // Stack traces: keep first N frames, collapse rest
    if (STACK_FRAME_RE.test(line)) {
      if (!inStack) {
        inStack = true;
        stackFrames = 0;
      }
      stackFrames++;
      if (stackFrames <= MAX_STACK_FRAMES) {
        out.push(line);
      } else if (stackFrames === MAX_STACK_FRAMES + 1) {
        let remaining = 1;
        while (i + 1 < lines.length && STACK_FRAME_RE.test(lines[i + 1] as string)) {
          i++;
          remaining++;
        }
        out.push(`    ... ${String(remaining)} more frames`);
      }
      continue;
    }
    if (inStack) {
      inStack = false;
      stackFrames = 0;
    }

    // Passing test lines: keep first few, count the rest
    if (PASS_LINE_RE.test(line)) {
      passLines++;
      if (passLines <= MAX_PASS_LINES) {
        out.push(line);
      } else {
        totalPassSuppressed++;
      }
      continue;
    }

    // Progress/download noise: suppress entirely
    if (NOISE_RE.test(line)) {
      continue;
    }

    // Non-pass line: flush any suppressed pass count
    if (totalPassSuppressed > 0) {
      out.push(`  ... ${String(totalPassSuppressed)} passing tests omitted`);
      totalPassSuppressed = 0;
    }
    passLines = 0;

    out.push(line);
  }

  if (totalPassSuppressed > 0) {
    out.push(`  ... ${String(totalPassSuppressed)} passing tests omitted`);
  }

  const collapsed = collapseRepeated(out);

  // Only compress if we actually saved something meaningful (>10% reduction)
  if (lines.length - collapsed.length < lines.length * 0.1) {
    return { text: raw, original: null };
  }

  return { text: collapsed.join("\n"), original: raw };
}
