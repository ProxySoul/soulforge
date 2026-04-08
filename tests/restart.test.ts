import { describe, expect, it } from "bun:test";
import { getRestartSpec } from "../src/core/restart.js";

describe("getRestartSpec", () => {
  it("restarts compiled Bun binaries from the real executable path", () => {
    const spec = getRestartSpec({
      execPath: "/private/tmp/soulforge",
      argv: ["bun", "/$bunfs/root/soulforge.js", "--headless", "fix it"],
      moduleUrl: "file:///$bunfs/root/index.js",
    });

    expect(spec.command).toBe("/private/tmp/soulforge");
    expect(spec.args).toEqual(["--headless", "fix it"]);
  });

  it("preserves the script entrypoint for Bun-based installs", () => {
    const spec = getRestartSpec({
      execPath: "/Users/blitz/.bun/bin/bun",
      argv: [
        "bun",
        "/Users/blitz/.bun/install/global/node_modules/@proxysoul/soulforge/dist/index.js",
        "--version",
      ],
      moduleUrl:
        "file:///Users/blitz/.bun/install/global/node_modules/@proxysoul/soulforge/dist/index.js",
    });

    expect(spec.command).toBe("/Users/blitz/.bun/bin/bun");
    expect(spec.args).toEqual([
      "/Users/blitz/.bun/install/global/node_modules/@proxysoul/soulforge/dist/index.js",
      "--version",
    ]);
  });
});
