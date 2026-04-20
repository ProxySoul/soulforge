import { describe, expect, test } from "bun:test";
import { redact } from "../src/hearth/redact.js";

describe("redact — telegram bot token in URL (H5)", () => {
  test("scrubs bot<id>:<token> inside a getFile URL path", () => {
    const url = "https://api.telegram.org/file/bot8781245817:AAH-abcdefghijklmnop_qrstuvwxyz012345/photos/file_42.jpg";
    const scrubbed = redact(url);
    expect(scrubbed).not.toContain("AAH-abcdefghijklmnop_qrstuvwxyz012345");
    expect(scrubbed).toContain("bot8781245817:***");
  });

  test("scrubs bare bot token form (123456:ABC...) — already covered, still works", () => {
    const s = "token=8781245817:AAH-abcdefghijklmnop_qrstuvwxyz012345";
    const scrubbed = redact(s);
    expect(scrubbed).not.toContain("AAH-abcdefghijklmnop_qrstuvwxyz012345");
    expect(scrubbed).toContain("8781245817:***");
  });

  test("scrubs token inside a thrown Error message", () => {
    const err = new Error(
      "fetch failed: GET https://api.telegram.org/file/bot8781245817:AAH-abcdefghijklmnop_qrstuvwxyz012345/foo",
    );
    const scrubbed = redact(err.message);
    expect(scrubbed).not.toContain("AAH-abcdefghijklmnop_qrstuvwxyz012345");
  });

  test("does NOT scrub normal numbers or non-token strings", () => {
    expect(redact("file size 12345678 bytes")).toContain("12345678");
    expect(redact("session-42 uptime 3600s")).toContain("3600s");
  });
});
