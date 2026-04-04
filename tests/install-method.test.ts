import { describe, expect, it } from "bun:test";
import {
  detectInstallMethod,
  getUpgradeCommand,
  getUpgradeArgs,
  type InstallMethod,
} from "../src/core/version.js";

describe("detectInstallMethod", () => {
  const VALID_METHODS: InstallMethod[] = ["npm", "pnpm", "yarn", "bun", "brew", "binary", "unknown"];

  it("returns a valid install method", () => {
    const method = detectInstallMethod();
    expect(VALID_METHODS).toContain(method);
  });

  it("is deterministic across calls", () => {
    const a = detectInstallMethod();
    const b = detectInstallMethod();
    expect(a).toBe(b);
  });
});

describe("getUpgradeCommand", () => {
  it("returns brew command for brew method", () => {
    const cmd = getUpgradeCommand("brew");
    expect(cmd).toContain("brew");
    expect(cmd).toContain("upgrade");
  });

  it("returns npm command for npm method", () => {
    const cmd = getUpgradeCommand("npm");
    expect(cmd).toContain("npm");
  });

  it("returns GitHub message for binary method", () => {
    const cmd = getUpgradeCommand("binary");
    expect(cmd).toContain("GitHub");
  });
});

describe("getUpgradeArgs", () => {
  it("returns spawn args for brew", () => {
    const args = getUpgradeArgs("brew");
    expect(args).not.toBeNull();
    expect(args!.command).toBe("sh");
    expect(args!.args.join(" ")).toContain("brew upgrade");
  });

  it("returns null for binary (cannot auto-upgrade)", () => {
    const args = getUpgradeArgs("binary");
    expect(args).toBeNull();
  });

  it("returns spawn args for all package managers", () => {
    for (const method of ["npm", "pnpm", "yarn", "bun"] as InstallMethod[]) {
      const args = getUpgradeArgs(method);
      expect(args).not.toBeNull();
      expect(args!.command).toBe(method);
    }
  });
});
