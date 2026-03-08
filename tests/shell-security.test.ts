import { describe, expect, it } from "bun:test";

/**
 * Tests for shell.ts security functions.
 * These guard against reading/writing forbidden files via shell commands.
 * A bypass here = attacker reads .env, SSH keys, credentials.
 */

function extractPathArgs(argsStr: string): string[] {
  return argsStr
    .split(/\s+/)
    .filter((a) => !a.startsWith("-"))
    .map((a) => a.replace(/['"]/g, ""));
}

function extractAllPathLikeArgs(command: string): string[] {
  const paths: string[] = [];
  const words = command.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g) ?? [];
  for (const w of words) {
    const cleaned = w.replace(/^['"]|['"]$/g, "");
    if (cleaned.startsWith("-") || cleaned.includes("=")) continue;
    if (/^[a-z_/~.][\w./~*?-]*$/i.test(cleaned)) {
      paths.push(cleaned);
    }
  }
  return paths;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

describe("extractPathArgs", () => {
  it("splits space-separated args", () => {
    expect(extractPathArgs("file1.ts file2.ts")).toEqual(["file1.ts", "file2.ts"]);
  });

  it("filters flags", () => {
    expect(extractPathArgs("-n --color=never file.ts")).toEqual(["file.ts"]);
  });

  it("strips quotes", () => {
    expect(extractPathArgs("'my file.ts' \"other.ts\"")).toEqual(["my", "file.ts", "other.ts"]);
  });

  it("handles empty string", () => {
    expect(extractPathArgs("")).toEqual([""]);
  });

  it("handles only flags", () => {
    expect(extractPathArgs("-a -b --verbose")).toEqual([]);
  });
});

describe("extractAllPathLikeArgs", () => {
  it("extracts paths from simple command", () => {
    const paths = extractAllPathLikeArgs("cat src/main.ts");
    expect(paths).toContain("src/main.ts");
  });

  it("extracts quoted paths", () => {
    const paths = extractAllPathLikeArgs("cat 'src/main.ts'");
    expect(paths).toContain("src/main.ts");
  });

  it("filters flags", () => {
    const paths = extractAllPathLikeArgs("grep -rn pattern src/");
    expect(paths).not.toContain("-rn");
    expect(paths).toContain("src/");
  });

  it("filters key=value args", () => {
    const paths = extractAllPathLikeArgs("CMD=true ./run.sh");
    expect(paths).not.toContain("CMD=true");
    expect(paths).toContain("./run.sh");
  });

  it("handles complex command", () => {
    const paths = extractAllPathLikeArgs("grep -rn 'pattern' --include='*.ts' src/ lib/");
    expect(paths).toContain("src/");
    expect(paths).toContain("lib/");
  });

  it("rejects non-path-like tokens", () => {
    const paths = extractAllPathLikeArgs("echo 'hello world'");
    // "echo" matches path-like regex, but "hello world" cleaned to "hello world" doesn't match
    expect(paths).toContain("echo");
  });

  it("handles empty command", () => {
    expect(extractAllPathLikeArgs("")).toEqual([]);
  });

  it("handles command with pipes", () => {
    const paths = extractAllPathLikeArgs("cat file.txt | grep pattern");
    expect(paths).toContain("file.txt");
  });

  it("extracts absolute paths", () => {
    const paths = extractAllPathLikeArgs("cat /etc/hostname");
    expect(paths).toContain("/etc/hostname");
  });

  it("extracts tilde paths", () => {
    const paths = extractAllPathLikeArgs("cat ~/.bashrc");
    expect(paths).toContain("~/.bashrc");
  });

  it("extracts glob patterns", () => {
    const paths = extractAllPathLikeArgs("ls src/**/*.ts");
    expect(paths).toContain("src/**/*.ts");
  });
});

describe("shellQuote", () => {
  it("quotes simple string", () => {
    expect(shellQuote("hello")).toBe("'hello'");
  });

  it("escapes single quotes", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it("handles empty string", () => {
    expect(shellQuote("")).toBe("''");
  });

  it("handles multiple single quotes", () => {
    expect(shellQuote("a'b'c")).toBe("'a'\\''b'\\''c'");
  });

  it("doesn't double-escape backslashes", () => {
    expect(shellQuote("path\\to\\file")).toBe("'path\\to\\file'");
  });

  it("handles special shell chars safely", () => {
    const quoted = shellQuote("$(rm -rf /)");
    expect(quoted).toBe("'$(rm -rf /)'");
  });

  it("handles backticks safely", () => {
    const quoted = shellQuote("`rm -rf /`");
    expect(quoted).toBe("'`rm -rf /`'");
  });

  it("handles newlines", () => {
    const quoted = shellQuote("line1\nline2");
    expect(quoted).toBe("'line1\nline2'");
  });

  it("handles semicolons", () => {
    const quoted = shellQuote("cmd; evil");
    expect(quoted).toBe("'cmd; evil'");
  });
});

describe("shell security — SUBSHELL_RE detection", () => {
  const SUBSHELL_RE = /\$\(|`[^`]*`|\$\{/;

  it("detects $() subshell", () => {
    expect(SUBSHELL_RE.test("echo $(cat /etc/passwd)")).toBe(true);
  });

  it("detects backtick subshell", () => {
    expect(SUBSHELL_RE.test("echo `cat /etc/passwd`")).toBe(true);
  });

  it("detects ${} expansion", () => {
    expect(SUBSHELL_RE.test("echo ${HOME}")).toBe(true);
  });

  it("allows plain commands", () => {
    expect(SUBSHELL_RE.test("ls -la src/")).toBe(false);
  });

  it("allows dollar sign in normal usage", () => {
    expect(SUBSHELL_RE.test("echo $PATH")).toBe(false);
  });

  it("detects nested subshell", () => {
    expect(SUBSHELL_RE.test("cat $(echo /etc/$(whoami))")).toBe(true);
  });
});

describe("shell security — redirect regex", () => {
  const OUTPUT_REDIR_RE = />{1,2}\s*([^\s|&;]+)/g;
  const INPUT_REDIR_RE = /<\s*([^\s|&;]+)/g;

  it("captures output redirect target", () => {
    const m = "echo hi > /tmp/out.txt".matchAll(OUTPUT_REDIR_RE);
    const matches = [...m];
    expect(matches.length).toBe(1);
    expect(matches[0]![1]).toBe("/tmp/out.txt");
  });

  it("captures append redirect target", () => {
    const m = "echo hi >> /tmp/out.txt".matchAll(OUTPUT_REDIR_RE);
    const matches = [...m];
    expect(matches.length).toBe(1);
    expect(matches[0]![1]).toBe("/tmp/out.txt");
  });

  it("captures input redirect target", () => {
    const m = "cmd < /etc/passwd".matchAll(INPUT_REDIR_RE);
    const matches = [...m];
    expect(matches.length).toBe(1);
    expect(matches[0]![1]).toBe("/etc/passwd");
  });

  it("captures redirect with space", () => {
    const m = "echo hi >  /tmp/out.txt".matchAll(OUTPUT_REDIR_RE);
    const matches = [...m];
    expect(matches[0]![1]).toBe("/tmp/out.txt");
  });

  it("captures multiple redirects", () => {
    const m = "cmd > /tmp/a >> /tmp/b".matchAll(OUTPUT_REDIR_RE);
    const matches = [...m];
    expect(matches.length).toBe(2);
  });
});

describe("shell security — FILE_READ_RE patterns", () => {
  const FILE_READ_RE =
    /\b(cat|head|tail|less|more|bat|xxd|hexdump|strings|base64|tac|nl|od|file)\s+(.+)/;

  it("matches cat command", () => {
    const m = "cat /etc/passwd".match(FILE_READ_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("cat");
    expect(m![2]).toBe("/etc/passwd");
  });

  it("matches base64 command", () => {
    const m = "base64 secret.key".match(FILE_READ_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("base64");
  });

  it("matches head with flags", () => {
    const m = "head -n 10 file.txt".match(FILE_READ_RE);
    expect(m).not.toBeNull();
    expect(m![2]).toBe("-n 10 file.txt");
  });

  it("doesn't match non-file commands", () => {
    expect("echo hello".match(FILE_READ_RE)).toBeNull();
    expect("ls -la".match(FILE_READ_RE)).toBeNull();
    expect("git status".match(FILE_READ_RE)).toBeNull();
  });

  it("matches file command embedded in pipeline", () => {
    const m = "cat secret.pem | base64".match(FILE_READ_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("cat");
  });
});
