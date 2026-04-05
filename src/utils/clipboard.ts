import { exec, spawn } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";

export function copyToClipboard(text: string): void {
  const isDarwin = process.platform === "darwin";
  const cmd = isDarwin ? "pbcopy" : "xclip";
  const args = isDarwin ? [] : ["-selection", "clipboard"];
  const proc = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
  proc.stdin.write(text);
  proc.stdin.end();
}

// ── Clipboard image reading ──

export interface ClipboardImage {
  data: Buffer;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

/**
 * Read image data from the system clipboard (async).
 * Returns null if no image is present.
 *
 * macOS: single osascript call that checks + extracts PNG to temp file.
 * Linux: xclip or wl-paste to read image/png target.
 */
export function readClipboardImageAsync(): Promise<ClipboardImage | null> {
  if (process.platform === "darwin") {
    return readClipboardImageDarwinAsync();
  }
  return readClipboardImageLinuxAsync();
}

function readClipboardImageDarwinAsync(): Promise<ClipboardImage | null> {
  const tmpFile = `/tmp/soulforge-clipboard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
  return new Promise((resolve) => {
    // Single osascript call: try to extract PNG, fail gracefully if no image
    exec(
      `osascript -e '
try
  set pngData to the clipboard as «class PNGf»
  set filePath to POSIX file "${tmpFile}"
  set fileRef to open for access filePath with write permission
  set eof fileRef to 0
  write pngData to fileRef
  close access fileRef
  return "ok"
on error
  return "no-image"
end try
' 2>/dev/null`,
      { timeout: 3000 },
      (err, stdout) => {
        if (err || !stdout.toString().trim().startsWith("ok")) {
          cleanup(tmpFile);
          resolve(null);
          return;
        }
        try {
          const data = readFileSync(tmpFile);
          unlinkSync(tmpFile);
          if (data.length > 0) {
            resolve({ data, mediaType: "image/png" });
            return;
          }
        } catch {
        } finally {
          cleanup(tmpFile);
        }
        resolve(null);
      },
    );
  });
}

function readClipboardImageLinuxAsync(): Promise<ClipboardImage | null> {
  return new Promise((resolve) => {
    // Try xclip first
    exec(
      "xclip -selection clipboard -t image/png -o 2>/dev/null",
      { timeout: 3000, maxBuffer: 20 * 1024 * 1024, encoding: "buffer" },
      (err, stdout) => {
        if (!err && stdout && stdout.length > 0) {
          resolve({ data: stdout, mediaType: "image/png" });
          return;
        }
        // Fallback: wl-paste for Wayland
        exec(
          "wl-paste --type image/png 2>/dev/null",
          { timeout: 3000, maxBuffer: 20 * 1024 * 1024, encoding: "buffer" },
          (err2, stdout2) => {
            if (!err2 && stdout2 && stdout2.length > 0) {
              resolve({ data: stdout2, mediaType: "image/png" });
              return;
            }
            resolve(null);
          },
        );
      },
    );
  });
}

function cleanup(tmpFile: string): void {
  try {
    unlinkSync(tmpFile);
  } catch {}
}
