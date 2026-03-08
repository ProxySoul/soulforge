import { describe, expect, it } from "bun:test";
import { isPrivateHostname, validateUrl } from "../src/core/tools/fetch-page.js";

describe("isPrivateHostname — IPv4", () => {
  it("blocks localhost", () => expect(isPrivateHostname("localhost")).toBe(true));
  it("blocks 127.0.0.1", () => expect(isPrivateHostname("127.0.0.1")).toBe(true));
  it("blocks 127.0.0.2 (startsWith 127.)", () => expect(isPrivateHostname("127.0.0.2")).toBe(true));
  it("blocks 127.255.255.255", () => expect(isPrivateHostname("127.255.255.255")).toBe(true));
  it("blocks 0.0.0.0", () => expect(isPrivateHostname("0.0.0.0")).toBe(true));
  it("blocks 10.x.x.x", () => expect(isPrivateHostname("10.0.0.1")).toBe(true));
  it("blocks 10.255.255.255", () => expect(isPrivateHostname("10.255.255.255")).toBe(true));
  it("blocks 192.168.x.x", () => expect(isPrivateHostname("192.168.1.1")).toBe(true));
  it("blocks 192.168.0.0", () => expect(isPrivateHostname("192.168.0.0")).toBe(true));
  it("blocks 172.16-31.x.x", () => {
    expect(isPrivateHostname("172.16.0.1")).toBe(true);
    expect(isPrivateHostname("172.31.255.255")).toBe(true);
  });
  it("allows 172.32.x.x (not private)", () => expect(isPrivateHostname("172.32.0.1")).toBe(false));
  it("allows 172.15.0.1 (below range)", () => expect(isPrivateHostname("172.15.0.1")).toBe(false));
  it("blocks AWS metadata endpoint", () => expect(isPrivateHostname("169.254.169.254")).toBe(true));
  it("allows 169.254.0.1 (only exact endpoint blocked)", () => expect(isPrivateHostname("169.254.0.1")).toBe(false));
  it("allows public IPs", () => {
    expect(isPrivateHostname("8.8.8.8")).toBe(false);
    expect(isPrivateHostname("1.1.1.1")).toBe(false);
  });
  it("blocks .internal suffix", () => expect(isPrivateHostname("api.internal")).toBe(true));
  it("blocks metadata.google.internal", () => expect(isPrivateHostname("metadata.google.internal")).toBe(true));
  it("blocks .local suffix", () => expect(isPrivateHostname("mypc.local")).toBe(true));
  it("allows normal domains", () => {
    expect(isPrivateHostname("example.com")).toBe(false);
    expect(isPrivateHostname("api.github.com")).toBe(false);
  });
});

describe("isPrivateHostname — IPv6", () => {
  it("blocks ::1 loopback", () => {
    expect(isPrivateHostname("::1")).toBe(true);
  });
  it("does not block [::1] (production checks ::1 without brackets)", () => {
    expect(isPrivateHostname("[::1]")).toBe(false);
  });
  it("blocks ULA fc00::/7", () => {
    expect(isPrivateHostname("fc00::1")).toBe(true);
    expect(isPrivateHostname("fd12:3456::1")).toBe(true);
  });
  it("blocks link-local fe80::/10", () => {
    expect(isPrivateHostname("fe80::1")).toBe(true);
    expect(isPrivateHostname("feb0::1")).toBe(true);
  });
  it("allows global unicast", () => {
    expect(isPrivateHostname("2001:db8::1")).toBe(false);
  });
});

describe("isPrivateHostname — bypass attempts", () => {
  it("blocks IPv6-mapped IPv4 (::ffff:127.0.0.1)", () => {
    expect(isPrivateHostname("::ffff:127.0.0.1")).toBe(true);
  });
  it("blocks IPv6-mapped private (::ffff:10.0.0.1)", () => {
    expect(isPrivateHostname("::ffff:10.0.0.1")).toBe(true);
  });
  it("blocks decimal IP (2130706433 = 127.0.0.1)", () => {
    expect(isPrivateHostname("2130706433")).toBe(true);
  });
  it("blocks octal IP (0177.0.0.1 = 127.0.0.1)", () => {
    expect(isPrivateHostname("0177.0.0.1")).toBe(true);
  });
  it("allows normal numeric-looking hostnames (short)", () => {
    expect(isPrivateHostname("1234567")).toBe(false); // 7 digits, below threshold
  });
  it("GAP: doesn't block hex IP (0x7f000001)", () => {
    expect(isPrivateHostname("0x7f000001")).toBe(false);
  });
  it("GAP: doesn't block DNS rebinding (attacker.com resolving to 127.0.0.1)", () => {
    expect(isPrivateHostname("attacker.com")).toBe(false);
  });
  it("case insensitive for IPv6", () => {
    expect(isPrivateHostname("FC00::1")).toBe(true);
    expect(isPrivateHostname("FE80::1")).toBe(true);
  });
  it("handles empty string", () => {
    expect(isPrivateHostname("")).toBe(false);
  });
  it("does not block empty brackets", () => {
    expect(isPrivateHostname("[]")).toBe(false);
  });
  it("does not treat hostname with port as private", () => {
    expect(isPrivateHostname("example.com:8080")).toBe(false);
  });
});

describe("validateUrl", () => {
  it("allows valid public URL", () => {
    expect(validateUrl("https://example.com")).toBeNull();
  });
  it("rejects invalid URL", () => {
    expect(validateUrl("not a url")).toBe("Invalid URL");
  });
  it("rejects empty string", () => {
    expect(validateUrl("")).toBe("Invalid URL");
  });
  it("blocks private URL (localhost)", () => {
    const result = validateUrl("http://localhost/api");
    expect(result).toContain("Blocked");
  });
  it("blocks private IP URL (10.0.0.1)", () => {
    const result = validateUrl("http://10.0.0.1/secret");
    expect(result).toContain("Blocked");
  });
  it("blocks FTP protocol", () => {
    const result = validateUrl("ftp://example.com");
    expect(result).toContain("Blocked protocol");
  });
  it("blocks file protocol", () => {
    const result = validateUrl("file:///etc/passwd");
    expect(result).toContain("Blocked protocol");
  });
  it("blocks data URI", () => {
    const result = validateUrl("data:text/html,<h1>hi</h1>");
    expect(result).toContain("Blocked protocol");
  });
  it("allows URL with auth", () => {
    expect(validateUrl("http://user:pass@example.com/api")).toBeNull();
  });
  it("allows URL with port", () => {
    expect(validateUrl("http://example.com:8080/api")).toBeNull();
  });
  it("blocks private URL with port", () => {
    const result = validateUrl("http://127.0.0.1:3000/api");
    expect(result).toContain("Blocked");
  });
  it("blocks IPv6 loopback URL (brackets stripped by URL parser)", () => {
    const result = validateUrl("http://[::1]/api");
    expect(result).toContain("Blocked");
  });
  it("GAP: IPv6-mapped IPv4 URL normalized by URL parser (::ffff:7f00:1)", () => {
    // URL parser normalizes ::ffff:127.0.0.1 → ::ffff:7f00:1, bypassing the mapped-IPv4 check
    const result = validateUrl("http://[::ffff:127.0.0.1]/api");
    expect(result).toBeNull();
  });
});
