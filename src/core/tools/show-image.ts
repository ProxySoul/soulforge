import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, resolve } from "node:path";
import type { ChatMessage, ToolResult } from "../../types/index.js";
import {
  canRenderImages,
  isKittyGraphicsTerminal,
  type KittyAnimFrame,
  renderAnimatedImage,
  renderImageFromData,
  supportsKittyAnimation,
} from "../terminal/image.js";

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB
const SUPPORTED_EXTENSIONS = /\.(png|jpg|jpeg|bmp|gif|webp|tiff|tif)$/i;
const URL_RE = /^https?:\/\//i;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const GIF_SIGNATURE = Buffer.from("GIF8");

export interface SoulVisionArgs {
  path: string;
  cols?: number;
}

/**
 * Convert non-PNG image data to PNG.
 * Tries multiple tools in order of availability:
 *   1. ffmpeg (cross-platform, most commonly installed on dev machines)
 *   2. sips (macOS built-in)
 *   3. magick / convert (ImageMagick)
 * Returns the PNG buffer or null if no converter is available.
 */
function convertToPng(data: Buffer, ext: string): Buffer | null {
  const id = `soul-vision-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
  const srcPath = resolve(tmpdir(), `${id}${ext}`);
  const dstPath = resolve(tmpdir(), `${id}.png`);

  try {
    writeFileSync(srcPath, data);

    const converters = [
      // ffmpeg: works everywhere, handles all formats
      `ffmpeg -y -i "${srcPath}" -frames:v 1 "${dstPath}" 2>/dev/null`,
      // sips: macOS built-in
      `sips -s format png "${srcPath}" --out "${dstPath}" 2>/dev/null`,
      // ImageMagick (v7 then v6)
      `magick "${srcPath}" "png:${dstPath}" 2>/dev/null`,
      `convert "${srcPath}" "png:${dstPath}" 2>/dev/null`,
    ];

    for (const cmd of converters) {
      try {
        execSync(cmd, { timeout: 10_000, stdio: "pipe" });
        if (existsSync(dstPath)) return readFileSync(dstPath);
      } catch {
        // try next
      }
    }

    return null;
  } finally {
    try {
      if (existsSync(srcPath)) execSync(`rm -f "${srcPath}"`, { stdio: "pipe", timeout: 2000 });
      if (existsSync(dstPath)) execSync(`rm -f "${dstPath}"`, { stdio: "pipe", timeout: 2000 });
    } catch {
      // cleanup best-effort
    }
  }
}

/**
 * Fetch an image from a URL. Returns { data, name } or an error string.
 */
async function fetchImageUrl(
  url: string,
): Promise<{ data: Buffer; name: string } | { error: string }> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "SoulForge/1.0" },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return { error: `HTTP ${String(res.status)}: ${res.statusText}` };
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) {
      return { error: `Not an image (content-type: ${contentType})` };
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return { error: "Empty response" };
    if (buf.length > MAX_IMAGE_SIZE) {
      return {
        error: `Image too large (${String(Math.round(buf.length / 1024 / 1024))}MB). Max: 10MB.`,
      };
    }

    // Extract filename from URL path
    const urlPath = new URL(url).pathname;
    const name = basename(urlPath) || "image.png";

    return { data: buf, name };
  } catch (e) {
    return { error: `Fetch failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Ensure buffer is PNG — convert if needed.
 */
export function ensurePng(data: Buffer, name: string): Buffer | null {
  // Already PNG?
  if (data.length >= 4 && data.subarray(0, 4).equals(PNG_SIGNATURE)) {
    return data;
  }

  // Need conversion — determine source extension
  const ext = extname(name).toLowerCase() || ".jpg";
  return convertToPng(data, ext);
}

/** Check if data is a GIF. */
function isGif(data: Buffer): boolean {
  return data.length >= 4 && data.subarray(0, 4).equals(GIF_SIGNATURE);
}

/**
 * Extract individual frames from a GIF.
 * Tries ffmpeg first (most common), then ImageMagick as fallback.
 * Returns array of { png: Buffer, delay: number (ms) } or null if no tool available.
 */
function extractGifFrames(data: Buffer): KittyAnimFrame[] | null {
  const id = `soul-vision-gif-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
  const srcPath = resolve(tmpdir(), `${id}.gif`);
  const outPattern = resolve(tmpdir(), `${id}-frame-%04d.png`);
  const outGlob = `${resolve(tmpdir(), id)}-frame-*.png`;

  try {
    writeFileSync(srcPath, data);

    // Parse GIF delays from the binary data directly (centiseconds in GCE blocks)
    const delays = parseGifDelays(data);

    // Strategy 1: ffmpeg (most commonly installed)
    let extracted = false;
    try {
      execSync(`ffmpeg -y -i "${srcPath}" -vsync 0 "${outPattern}" 2>/dev/null`, {
        timeout: 30_000,
        stdio: "pipe",
      });
      extracted = true;
    } catch {
      // ffmpeg not available
    }

    // Strategy 2: ImageMagick (convert or magick)
    if (!extracted) {
      for (const cmd of ["magick", "convert"]) {
        try {
          execSync(`${cmd} "${srcPath}" -coalesce "${outPattern}" 2>/dev/null`, {
            timeout: 30_000,
            stdio: "pipe",
          });
          extracted = true;
          break;
        } catch {
          // not available
        }
      }
    }

    if (!extracted) return null;

    // Read extracted frame PNGs
    const frameFiles: string[] = [];
    try {
      const ls = execSync(`ls -1 ${outGlob} 2>/dev/null`, {
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf-8",
      });
      frameFiles.push(...ls.trim().split("\n").filter(Boolean).sort());
    } catch {
      return null;
    }

    if (frameFiles.length === 0) return null;

    const frames: KittyAnimFrame[] = [];
    for (const file of frameFiles) {
      const png = readFileSync(file);
      frames.push({ png, delay: delays[frames.length] ?? 100 });
    }

    return frames.length > 0 ? frames : null;
  } finally {
    try {
      execSync(`rm -f "${srcPath}" ${outGlob} 2>/dev/null`, { stdio: "pipe", timeout: 3000 });
    } catch {
      // best-effort
    }
  }
}

/**
 * Parse frame delays directly from GIF binary data.
 * GIF stores delays in Graphics Control Extension (GCE) blocks in centiseconds.
 * This avoids needing any external tool just to read delays.
 */
export function parseGifDelays(data: Buffer): number[] {
  const delays: number[] = [];
  let i = 0;

  // Skip GIF header (6 bytes) + Logical Screen Descriptor (7 bytes)
  i = 6;
  if (i + 7 > data.length) return delays;

  // Check for Global Color Table
  const packed = data[i + 4] ?? 0;
  const hasGCT = (packed & 0x80) !== 0;
  const gctSize = hasGCT ? 3 * (1 << ((packed & 0x07) + 1)) : 0;
  i += 7 + gctSize;

  while (i < data.length) {
    const blockType = data[i];

    if (blockType === 0x21) {
      // Extension block
      const label = data[i + 1];
      if (label === 0xf9 && i + 6 <= data.length) {
        // Graphics Control Extension — delay is at bytes 3-4 (little-endian, centiseconds)
        const delayCentiseconds = (data[i + 4] ?? 0) | ((data[i + 5] ?? 0) << 8);
        // 0 centiseconds means "as fast as possible" → use 100ms default
        delays.push((delayCentiseconds <= 0 ? 10 : delayCentiseconds) * 10);
        i += 8; // GCE is always: 21 F9 04 <packed> <delay_lo> <delay_hi> 00
      } else {
        // Skip other extension blocks
        i += 2;
        while (i < data.length) {
          const blockSize = data[i] ?? 0;
          i += 1 + blockSize;
          if (blockSize === 0) break;
        }
      }
    } else if (blockType === 0x2c) {
      // Image descriptor — skip it + LCT + image data
      if (i + 10 > data.length) break;
      const imgPacked = data[i + 9] ?? 0;
      const hasLCT = (imgPacked & 0x80) !== 0;
      const lctSize = hasLCT ? 3 * (1 << ((imgPacked & 0x07) + 1)) : 0;
      i += 10 + lctSize;
      i += 1; // LZW minimum code size
      // Skip sub-blocks
      while (i < data.length) {
        const blockSize = data[i] ?? 0;
        i += 1 + blockSize;
        if (blockSize === 0) break;
      }
    } else if (blockType === 0x3b) {
      break; // Trailer
    } else {
      i++; // Unknown, skip
    }
  }

  return delays;
}

/**
 * soul_vision tool — displays an image inline in the chat.
 * Accepts local file paths or URLs. Converts non-PNG formats automatically.
 */
export async function showImage(
  args: SoulVisionArgs,
  cwd: string,
): Promise<ToolResult & { _imageArt?: Array<{ name: string; lines: string[] }> }> {
  if (!canRenderImages()) {
    return {
      success: false,
      output: "Terminal does not support image rendering (no truecolor).",
    };
  }

  let data: Buffer;
  let name: string;

  if (URL_RE.test(args.path)) {
    // ── URL mode ──
    const result = await fetchImageUrl(args.path);
    if ("error" in result) {
      return { success: false, output: result.error };
    }
    data = result.data;
    name = result.name;
  } else {
    // ── Local file mode ──
    const filePath = resolve(cwd, args.path);

    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(filePath);
    } catch {
      return { success: false, output: `File not found: ${args.path}` };
    }

    if (!stat.isFile()) {
      return { success: false, output: `Not a file: ${args.path}` };
    }

    if (stat.size > MAX_IMAGE_SIZE) {
      return {
        success: false,
        output: `Image too large (${String(Math.round(stat.size / 1024 / 1024))}MB). Max: 10MB.`,
      };
    }

    if (!SUPPORTED_EXTENSIONS.test(filePath)) {
      return {
        success: false,
        output: "Unsupported format. Supported: PNG, JPG, WebP, GIF, BMP, TIFF.",
      };
    }

    try {
      data = readFileSync(filePath);
    } catch (e) {
      return { success: false, output: `Failed to read file: ${String(e)}` };
    }
    name = args.path;
  }

  // GIF animation path — extract frames and animate in Kitty
  if (isGif(data) && supportsKittyAnimation()) {
    const frames = extractGifFrames(data);
    if (frames && frames.length > 1) {
      const art = renderAnimatedImage(frames, name, { cols: args.cols });
      if (art) {
        return {
          success: true,
          output: `Displayed animated image: ${name} (${String(frames.length)} frames, ${String(art.lines.length)} rows)`,
          _imageArt: [art],
        };
      }
    }
    // Fall through to static if frame extraction failed
  }

  // Convert to PNG if needed (Kitty only accepts PNG / raw pixels)
  const pngData = ensurePng(data, name);
  if (!pngData) {
    return {
      success: false,
      output:
        "Failed to convert image to PNG. Install ffmpeg (brew install ffmpeg / apt install ffmpeg) for non-PNG format support.",
    };
  }

  const art = renderImageFromData(pngData, name, { cols: args.cols });
  if (!art) {
    return {
      success: false,
      output: "Failed to render image (corrupt or unsupported PNG variant).",
    };
  }

  return {
    success: true,
    output: `Displayed image: ${name} (${String(art.lines.length)} rows)`,
    _imageArt: [art],
  };
}

/**
 * Re-fetch and re-transmit images for a restored session.
 * Kitty image IDs are ephemeral — they're lost when the terminal session ends.
 * This scans messages for soul_vision tool calls with stale kittyImageId,
 * re-fetches the image from the original URL/path, and re-transmits to Kitty
 * so placeholders render correctly again.
 */
export async function restoreSessionImages(messages: ChatMessage[], cwd: string): Promise<number> {
  if (!canRenderImages() || !isKittyGraphicsTerminal()) return 0;

  const staleEntries: Array<{
    tc: ChatMessage["toolCalls"] extends (infer T)[] | undefined ? T : never;
    imgIdx: number;
  }> = [];

  for (const msg of messages) {
    if (!msg.toolCalls) continue;
    for (const tc of msg.toolCalls) {
      if (tc.name !== "soul_vision" || !tc.imageArt) continue;
      for (let i = 0; i < tc.imageArt.length; i++) {
        const img = tc.imageArt[i];
        if (img?.kittyImageId) {
          staleEntries.push({ tc, imgIdx: i });
        }
      }
    }
  }

  if (staleEntries.length === 0) return 0;

  // Re-fetch and re-render each image concurrently (with a concurrency limit)
  const CONCURRENCY = 3;
  let idx = 0;
  let restored = 0;

  async function processNext(): Promise<void> {
    while (idx < staleEntries.length) {
      const current = idx++;
      const entry = staleEntries[current];
      if (!entry) continue;

      const { tc, imgIdx } = entry;
      const path = tc.args?.path as string | undefined;
      if (!path || typeof path !== "string") continue;

      try {
        let data: Buffer | null = null;
        let name: string;

        if (URL_RE.test(path)) {
          const result = await fetchImageUrl(path);
          if ("error" in result) continue;
          data = result.data;
          name = result.name;
        } else {
          const filePath = resolve(cwd, path);
          if (!existsSync(filePath)) continue;
          const stat = statSync(filePath);
          if (!stat.isFile() || stat.size > MAX_IMAGE_SIZE) continue;
          data = readFileSync(filePath);
          name = path;
        }

        if (!data) continue;

        // Re-render: GIF animation or static image
        let art: {
          kittyImageId?: number;
          kittyCols?: number;
          kittyRows?: number;
          lines: string[];
          name: string;
        } | null = null;

        if (isGif(data) && supportsKittyAnimation()) {
          const frames = extractGifFrames(data);
          if (frames && frames.length > 1) {
            art = renderAnimatedImage(frames, name, { cols: tc.imageArt?.[imgIdx]?.kittyCols });
          }
        }

        if (!art) {
          const pngData = ensurePng(data, name);
          if (!pngData) continue;
          art = renderImageFromData(pngData, name, { cols: tc.imageArt?.[imgIdx]?.kittyCols });
        }

        if (art && tc.imageArt) {
          // Update the stale entry in-place with the new Kitty image ID
          const prev = tc.imageArt[imgIdx];
          tc.imageArt[imgIdx] = {
            ...(prev ?? { name: art.name, lines: [] }),
            kittyImageId: art.kittyImageId,
            kittyCols: art.kittyCols,
            kittyRows: art.kittyRows,
            lines: art.lines,
          };
          restored++;
        }
      } catch {
        // Best-effort — skip failed images
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, staleEntries.length) }, () =>
    processNext(),
  );
  await Promise.all(workers);
  return restored;
}
