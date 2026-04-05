import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { deflateSync } from "node:zlib";
import {
	canRenderImages,
	decodePng,
	getPngDimensions,
	imageToHalfBlockArt,
	isKittyGraphicsTerminal,
	sampleArea,
	supportsKittyAnimation,
} from "../src/core/terminal/image.js";
import { ensurePng, hasFfmpeg, hasYtDlp, parseGifDelays } from "../src/core/tools/show-image.js";

// ── Helpers ──

/** Save and restore env vars around each test. */
const ENV_KEYS = [
	"COLORTERM",
	"TERM_PROGRAM",
	"KITTY_WINDOW_ID",
	"WEZTERM_PANE",
	"ITERM_SESSION_ID",
	"KONSOLE_VERSION",
] as const;

let savedEnv: Record<string, string | undefined>;

function clearTermEnv() {
	for (const key of ENV_KEYS) delete process.env[key];
}

/** Build a minimal valid PNG buffer (RGB, 8-bit, no filter). */
function buildPng(width: number, height: number, rgb: [number, number, number] = [255, 0, 0]): Buffer {
	const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

	// IHDR: 13 bytes — width(4) height(4) bitDepth(1) colorType(1) compression(1) filter(1) interlace(1)
	const ihdrData = Buffer.alloc(13);
	ihdrData.writeUInt32BE(width, 0);
	ihdrData.writeUInt32BE(height, 4);
	ihdrData[8] = 8; // bit depth
	ihdrData[9] = 2; // color type: RGB
	const ihdr = buildChunk("IHDR", ihdrData);

	// IDAT: raw pixel data with filter byte 0 (None) per row
	const rawRows = Buffer.alloc(height * (1 + width * 3));
	for (let y = 0; y < height; y++) {
		const rowStart = y * (1 + width * 3);
		rawRows[rowStart] = 0; // filter: None
		for (let x = 0; x < width; x++) {
			const offset = rowStart + 1 + x * 3;
			rawRows[offset] = rgb[0];
			rawRows[offset + 1] = rgb[1];
			rawRows[offset + 2] = rgb[2];
		}
	}
	const compressed = deflateSync(rawRows);
	const idat = buildChunk("IDAT", compressed);

	// IEND
	const iend = buildChunk("IEND", Buffer.alloc(0));

	return Buffer.concat([sig, ihdr, idat, iend]);
}

function buildChunk(type: string, data: Buffer): Buffer {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const typeB = Buffer.from(type, "ascii");
	const crcInput = Buffer.concat([typeB, data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(crcInput), 0);
	return Buffer.concat([len, typeB, data, crc]);
}

function crc32(buf: Buffer): number {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) {
		c ^= buf[i]!;
		for (let j = 0; j < 8; j++) {
			c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
		}
	}
	return (c ^ 0xffffffff) >>> 0;
}

/** Build a minimal GIF89a with given frame delays (centiseconds). */
function buildGif(delays: number[]): Buffer {
	const parts: Buffer[] = [];

	// Header
	parts.push(Buffer.from("GIF89a"));

	// Logical Screen Descriptor: 1x1, no GCT
	const lsd = Buffer.alloc(7);
	lsd.writeUInt16LE(1, 0); // width
	lsd.writeUInt16LE(1, 2); // height
	lsd[4] = 0x00; // packed: no GCT
	parts.push(lsd);

	for (const delay of delays) {
		// Graphics Control Extension
		const gce = Buffer.from([
			0x21, 0xf9, 0x04,
			0x00, // packed
			delay & 0xff, (delay >> 8) & 0xff, // delay (centiseconds, LE)
			0x00, // transparent color index
			0x00, // block terminator
		]);
		parts.push(gce);

		// Image Descriptor: 1x1, no LCT
		const imgDesc = Buffer.alloc(10);
		imgDesc[0] = 0x2c; // image separator
		imgDesc[9] = 0x80 | 0x00; // packed: has LCT, 2 colors (size=0 → 2^(0+1)=2)
		imgDesc.writeUInt16LE(1, 5); // width
		imgDesc.writeUInt16LE(1, 7); // height
		parts.push(imgDesc);

		// Local Color Table (2 entries × 3 bytes)
		parts.push(Buffer.from([0, 0, 0, 255, 255, 255]));

		// LZW minimum code size + image data sub-blocks
		parts.push(Buffer.from([
			0x02, // LZW min code size
			0x02, 0x4c, 0x01, // sub-block: 2 bytes of LZW data
			0x00, // block terminator
		]));
	}

	// Trailer
	parts.push(Buffer.from([0x3b]));

	return Buffer.concat(parts);
}

// ── Tests ──

describe("canRenderImages", () => {
	beforeEach(() => {
		savedEnv = {};
		for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
		clearTermEnv();
	});
	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	it("returns true for COLORTERM=truecolor", () => {
		process.env.COLORTERM = "truecolor";
		expect(canRenderImages()).toBe(true);
	});

	it("returns true for COLORTERM=24bit", () => {
		process.env.COLORTERM = "24bit";
		expect(canRenderImages()).toBe(true);
	});

	it("returns true for KITTY_WINDOW_ID", () => {
		process.env.KITTY_WINDOW_ID = "1";
		expect(canRenderImages()).toBe(true);
	});

	it("returns true for TERM_PROGRAM=ghostty", () => {
		process.env.TERM_PROGRAM = "ghostty";
		expect(canRenderImages()).toBe(true);
	});

	it("returns true for ITERM_SESSION_ID", () => {
		process.env.ITERM_SESSION_ID = "abc";
		expect(canRenderImages()).toBe(true);
	});

	it("returns false for plain terminal", () => {
		expect(canRenderImages()).toBe(false);
	});
});

describe("isKittyGraphicsTerminal", () => {
	beforeEach(() => {
		savedEnv = {};
		for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
		clearTermEnv();
	});
	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	it("returns true for Kitty", () => {
		process.env.KITTY_WINDOW_ID = "1";
		expect(isKittyGraphicsTerminal()).toBe(true);
	});

	it("returns true for Ghostty", () => {
		process.env.TERM_PROGRAM = "ghostty";
		expect(isKittyGraphicsTerminal()).toBe(true);
	});

	it("returns false for iTerm2 (no Unicode placeholders)", () => {
		process.env.ITERM_SESSION_ID = "abc";
		expect(isKittyGraphicsTerminal()).toBe(false);
	});

	it("returns false for WezTerm", () => {
		process.env.WEZTERM_PANE = "0";
		expect(isKittyGraphicsTerminal()).toBe(false);
	});

	it("returns false for Konsole (no Unicode placeholders)", () => {
		process.env.KONSOLE_VERSION = "24.08";
		expect(isKittyGraphicsTerminal()).toBe(false);
	});

	it("returns false for Warp", () => {
		process.env.TERM_PROGRAM = "warp";
		expect(isKittyGraphicsTerminal()).toBe(false);
	});

	it("returns false for plain terminal", () => {
		expect(isKittyGraphicsTerminal()).toBe(false);
	});

	it("iTerm2 exclusion wins over KITTY_WINDOW_ID", () => {
		process.env.KITTY_WINDOW_ID = "1";
		process.env.ITERM_SESSION_ID = "abc";
		expect(isKittyGraphicsTerminal()).toBe(false);
	});
});

describe("supportsKittyAnimation", () => {
	beforeEach(() => {
		savedEnv = {};
		for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
		clearTermEnv();
	});
	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	it("returns true for Kitty (KITTY_WINDOW_ID)", () => {
		process.env.KITTY_WINDOW_ID = "1";
		expect(supportsKittyAnimation()).toBe(true);
	});

	it("returns true for TERM_PROGRAM=kitty", () => {
		process.env.TERM_PROGRAM = "kitty";
		expect(supportsKittyAnimation()).toBe(true);
	});

	it("returns false for Ghostty (no animation support)", () => {
		process.env.TERM_PROGRAM = "ghostty";
		expect(supportsKittyAnimation()).toBe(false);
	});

	it("returns false for plain terminal", () => {
		expect(supportsKittyAnimation()).toBe(false);
	});
});

describe("getPngDimensions", () => {
	it("reads dimensions from a valid PNG", () => {
		const png = buildPng(42, 17);
		expect(getPngDimensions(png)).toEqual({ width: 42, height: 17 });
	});

	it("reads large dimensions", () => {
		const png = buildPng(1920, 1080);
		expect(getPngDimensions(png)).toEqual({ width: 1920, height: 1080 });
	});

	it("returns null for too-short buffer", () => {
		expect(getPngDimensions(Buffer.alloc(10))).toBeNull();
	});

	it("returns null for non-PNG data", () => {
		expect(getPngDimensions(Buffer.from("not a png file at all"))).toBeNull();
	});

	it("returns null for JPEG data", () => {
		const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(20).fill(0)]);
		expect(getPngDimensions(jpeg)).toBeNull();
	});
});

describe("decodePng", () => {
	it("decodes a solid red 2x2 PNG", () => {
		const png = buildPng(2, 2, [255, 0, 0]);
		const result = decodePng(png);
		expect(result).not.toBeNull();
		expect(result!.width).toBe(2);
		expect(result!.height).toBe(2);
		// 4 pixels × 3 bytes = 12 bytes
		expect(result!.pixels.length).toBe(12);
		// Every pixel should be red
		for (let i = 0; i < 4; i++) {
			expect(result!.pixels[i * 3]).toBe(255);
			expect(result!.pixels[i * 3 + 1]).toBe(0);
			expect(result!.pixels[i * 3 + 2]).toBe(0);
		}
	});

	it("decodes a solid green 1x1 PNG", () => {
		const png = buildPng(1, 1, [0, 255, 0]);
		const result = decodePng(png);
		expect(result).not.toBeNull();
		expect(result!.pixels[0]).toBe(0);
		expect(result!.pixels[1]).toBe(255);
		expect(result!.pixels[2]).toBe(0);
	});

	it("returns null for non-PNG data", () => {
		expect(decodePng(Buffer.from("hello world"))).toBeNull();
	});

	it("returns null for truncated PNG", () => {
		const png = buildPng(2, 2);
		expect(decodePng(png.subarray(0, 20))).toBeNull();
	});

	it("returns null for empty buffer", () => {
		expect(decodePng(Buffer.alloc(0))).toBeNull();
	});
});

describe("sampleArea", () => {
	it("averages a single pixel", () => {
		// 2x2 image: TL=red, TR=green, BL=blue, BR=white
		const pixels = Buffer.from([
			255, 0, 0, 0, 255, 0,
			0, 0, 255, 255, 255, 255,
		]);
		expect(sampleArea(pixels, 2, 2, 0, 0, 1, 1)).toEqual([255, 0, 0]);
		expect(sampleArea(pixels, 2, 2, 1, 0, 2, 1)).toEqual([0, 255, 0]);
		expect(sampleArea(pixels, 2, 2, 0, 1, 1, 2)).toEqual([0, 0, 255]);
		expect(sampleArea(pixels, 2, 2, 1, 1, 2, 2)).toEqual([255, 255, 255]);
	});

	it("averages a 2x2 region", () => {
		// 2x2 all red → average is red
		const pixels = Buffer.from([
			255, 0, 0, 255, 0, 0,
			255, 0, 0, 255, 0, 0,
		]);
		expect(sampleArea(pixels, 2, 2, 0, 0, 2, 2)).toEqual([255, 0, 0]);
	});

	it("returns [0,0,0] for empty region", () => {
		const pixels = Buffer.from([255, 0, 0]);
		expect(sampleArea(pixels, 1, 1, 5, 5, 5, 5)).toEqual([0, 0, 0]);
	});

	it("clamps to image bounds", () => {
		const pixels = Buffer.from([100, 150, 200]);
		// Region extends beyond 1x1 image — should still sample the one pixel
		expect(sampleArea(pixels, 1, 1, 0, 0, 10, 10)).toEqual([100, 150, 200]);
	});
});

describe("imageToHalfBlockArt", () => {
	it("returns null for non-existent file", () => {
		expect(imageToHalfBlockArt("/nonexistent/path.png")).toBeNull();
	});

	it("returns null for non-image extension", () => {
		expect(imageToHalfBlockArt("/tmp/file.txt")).toBeNull();
	});
});

describe("parseGifDelays", () => {
	it("parses delays from a multi-frame GIF", () => {
		const gif = buildGif([10, 20, 5]); // 100ms, 200ms, 50ms
		const delays = parseGifDelays(gif);
		expect(delays).toEqual([100, 200, 50]);
	});

	it("parses single-frame GIF", () => {
		const gif = buildGif([15]);
		expect(parseGifDelays(gif)).toEqual([150]);
	});

	it("treats 0 delay as 100ms default", () => {
		const gif = buildGif([0]);
		expect(parseGifDelays(gif)).toEqual([100]);
	});

	it("returns empty array for non-GIF data", () => {
		expect(parseGifDelays(Buffer.from("not a gif"))).toEqual([]);
	});

	it("returns empty array for truncated data", () => {
		expect(parseGifDelays(Buffer.alloc(5))).toEqual([]);
	});
});

describe("ensurePng", () => {
	it("returns PNG data unchanged", () => {
		const png = buildPng(4, 4);
		const result = ensurePng(png, "test.png");
		expect(result).not.toBeNull();
		// Should be the exact same buffer (no conversion needed)
		expect(result!.equals(png)).toBe(true);
	});

	it("returns null for non-PNG without converter tools", () => {
		// JPEG-like data — conversion depends on external tools
		const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(100).fill(0)]);
		// This may return null or a valid PNG depending on whether ffmpeg/sips/magick is installed
		// We just verify it doesn't throw
		const result = ensurePng(jpeg, "test.jpg");
		expect(result === null || Buffer.isBuffer(result)).toBe(true);
	});
});

describe("hasFfmpeg / hasYtDlp", () => {
	it("hasFfmpeg returns a boolean", () => {
		expect(typeof hasFfmpeg()).toBe("boolean");
	});

	it("hasYtDlp returns a boolean", () => {
		expect(typeof hasYtDlp()).toBe("boolean");
	});

	it("hasFfmpeg is consistent across calls (cached)", () => {
		const first = hasFfmpeg();
		const second = hasFfmpeg();
		expect(first).toBe(second);
	});

	it("hasYtDlp is consistent across calls (cached)", () => {
		const first = hasYtDlp();
		const second = hasYtDlp();
		expect(first).toBe(second);
	});
});
