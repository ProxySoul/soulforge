/**
 * Path display + comparison helpers.
 *
 * Robust across macOS (case-insensitive HFS+/APFS + /var→/private/var symlink),
 * Linux (case-sensitive, arbitrary symlinks), and Windows drive letters.
 *
 * Two axes this module covers:
 *   1. Canonicalization — resolve symlinks, normalize case on case-insensitive
 *      filesystems, so two strings that refer to the same file compare equal.
 *   2. Display — prefer cwd-relative paths when inside cwd, fall back to `~/…`
 *      for home paths, else absolute.
 */
import { realpathSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

const IS_DARWIN = platform() === "darwin";
const IS_WIN32 = platform() === "win32";
/** macOS HFS+/APFS default to case-insensitive; Windows NTFS is case-insensitive too. */
const CASE_INSENSITIVE_FS = IS_DARWIN || IS_WIN32;

const HOME = homedir();

/**
 * Canonicalize a filesystem path for comparison:
 *   - resolve to absolute
 *   - resolve symlinks (walks up parent dirs for non-existent leaves)
 *   - lowercase on case-insensitive filesystems
 *
 * Never throws. Returns the best canonical form available.
 */
export function canonicalizePath(p: string): string {
  if (!p) return p;
  let abs = isAbsolute(p) ? p : resolve(p);

  // Try realpath on the full path first. If leaf doesn't exist, walk up until
  // a realpath succeeds, then re-join the untouched tail. Handles edits to
  // files that don't exist yet (create_file) and /var→/private/var on macOS.
  try {
    abs = realpathSync(abs);
  } catch {
    const parts = abs.split(sep);
    const tail: string[] = [];
    while (parts.length > 1) {
      tail.unshift(parts.pop() as string);
      const head = parts.join(sep) || sep;
      try {
        const headReal = realpathSync(head);
        abs = tail.length > 0 ? `${headReal}${sep}${tail.join(sep)}` : headReal;
        break;
      } catch {
        // keep walking up
      }
    }
  }

  return CASE_INSENSITIVE_FS ? abs.toLowerCase() : abs;
}

/** True when `filePath` is inside `cwd` (canonical, case/symlink aware). */
export function isInsideCwd(filePath: string, cwd: string = process.cwd()): boolean {
  const canonFile = canonicalizePath(filePath);
  const canonCwd = canonicalizePath(cwd);
  if (canonFile === canonCwd) return true;
  const withSep = canonCwd.endsWith(sep) ? canonCwd : canonCwd + sep;
  return canonFile.startsWith(withSep);
}

/**
 * Format a path for user display:
 *   - inside cwd → relative (e.g. "src/foo.ts")
 *   - under $HOME → "~/…"
 *   - else → absolute
 *
 * Preserves original case from the input path — canonicalization is only used
 * for the inside/outside decision, never mutates what the user sees.
 */
export function displayPath(filePath: string, cwd: string = process.cwd()): string {
  if (!filePath) return filePath;
  const abs = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);

  if (isInsideCwd(abs, cwd)) {
    const rel = relative(cwd, abs);
    return rel === "" ? "." : rel;
  }

  // ~/… for paths under home (pure prefix match on canonical form, display
  // uses original-cased absolute path)
  const canonAbs = canonicalizePath(abs);
  const canonHome = canonicalizePath(HOME);
  if (canonAbs === canonHome) return "~";
  const homeWithSep = canonHome.endsWith(sep) ? canonHome : canonHome + sep;
  if (canonAbs.startsWith(homeWithSep)) {
    const tail = abs.slice(HOME.length);
    return `~${tail.startsWith(sep) ? tail : sep + tail}`;
  }

  return abs;
}

/** True if the path exists as a file or directory. Never throws. */
export function pathExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}
