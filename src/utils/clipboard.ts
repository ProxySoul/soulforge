import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";

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
 * Read image data from the system clipboard.
 * Returns null if no image is present.
 *
 * macOS: uses osascript to check clipboard type, then pngpaste or screencapture fallback.
 * Linux: uses xclip to read image/png target.
 */
export function readClipboardImage(): ClipboardImage | null {
  try {
    if (process.platform === "darwin") {
      return readClipboardImageDarwin();
    }
    return readClipboardImageLinux();
  } catch {
    return null;
  }
}

function readClipboardImageDarwin(): ClipboardImage | null {
  // Check if clipboard contains image data via AppleScript
  try {
    const info = execSync("osascript -e 'clipboard info' 2>/dev/null", {
      encoding: "utf-8",
      timeout: 3000,
    });
    const hasImage =
      /«class PNGf»|«class TIFF»|«class JPEG»|public\.png|public\.tiff|public\.jpeg/.test(info);
    if (!hasImage) return null;
  } catch {
    return null;
  }

  // Extract PNG data via osascript writing to a temp file
  // (osascript cannot reliably pipe binary data to stdout)
  const tmpFile = `/tmp/soulforge-clipboard-${Date.now()}.png`;
  try {
    execSync(
      `osascript -e '
set pngData to the clipboard as «class PNGf»
set filePath to POSIX file "${tmpFile}"
set fileRef to open for access filePath with write permission
set eof fileRef to 0
write pngData to fileRef
close access fileRef
' 2>/dev/null`,
      { timeout: 5000 },
    );
    if (existsSync(tmpFile)) {
      const data = readFileSync(tmpFile);
      unlinkSync(tmpFile);
      if (data.length > 0) {
        return { data, mediaType: "image/png" };
      }
    }
  } catch {
    // Clean up temp file on failure
    try {
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
    } catch {}
  }

  return null;
}

function readClipboardImageLinux(): ClipboardImage | null {
  // Try xclip first (most common)
  try {
    const data = execSync("xclip -selection clipboard -t image/png -o 2>/dev/null", {
      timeout: 3000,
      maxBuffer: 20 * 1024 * 1024,
    });
    if (data.length > 0) {
      return { data: Buffer.from(data), mediaType: "image/png" };
    }
  } catch {
    // xclip not available or no image
  }

  // Fallback: wl-paste for Wayland
  try {
    const data = execSync("wl-paste --type image/png 2>/dev/null", {
      timeout: 3000,
      maxBuffer: 20 * 1024 * 1024,
    });
    if (data.length > 0) {
      return { data: Buffer.from(data), mediaType: "image/png" };
    }
  } catch {
    // No image available
  }

  return null;
}
