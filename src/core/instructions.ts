import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { marked } from "marked";

interface InstructionSource {
  id: string;
  label: string;
  files: string[];
  defaultEnabled: boolean;
}

// Unlike skills, global instruction files are user-authored personal steering.
// Keep project-local content later in prompt so repo guidance overrides global defaults on conflicts.
export const INSTRUCTION_SOURCES: InstructionSource[] = [
  {
    id: "soulforge",
    label: "SOULFORGE.md",
    files: ["SOULFORGE.md", ".soulforge/SOULFORGE.md", ".soulforge/instructions.md"],
    defaultEnabled: true,
  },
  {
    id: "claude",
    label: "CLAUDE.md",
    files: ["CLAUDE.md", ".claude/instructions.md"],
    defaultEnabled: false,
  },
  {
    id: "cursorrules",
    label: ".cursorrules",
    files: [".cursorrules", ".cursor/rules", ".cursor/rules.md"],
    defaultEnabled: false,
  },
  {
    id: "github-copilot",
    label: "Copilot Instructions",
    files: [".github/copilot-instructions.md"],
    defaultEnabled: false,
  },
  {
    id: "cline",
    label: ".clinerules",
    files: [".clinerules", ".cline/rules"],
    defaultEnabled: false,
  },
  {
    id: "windsurf",
    label: ".windsurfrules",
    files: [".windsurfrules"],
    defaultEnabled: false,
  },
  {
    id: "aider",
    label: ".aider.conf.yml",
    files: [".aider.conf.yml", ".aiderignore"],
    defaultEnabled: false,
  },
  {
    id: "codex",
    label: "AGENTS.md",
    files: ["AGENTS.md", ".agents/instructions.md"],
    defaultEnabled: false,
  },
  {
    id: "amp",
    label: "AMPLIFY.md",
    files: ["AMPLIFY.md", ".amp/instructions.md"],
    defaultEnabled: false,
  },
];

interface LoadedInstruction {
  source: string;
  file: string;
  content: string;
  scope: "project" | "global";
}

interface InstructionSection {
  heading: string;
  depth: number;
  content: string;
}

interface InstructionStructure {
  sections: InstructionSection[];
  codeBlocks: Array<{ lang: string; code: string }>;
  raw: string;
}

/** Parse a markdown instruction file into structured sections using marked.lexer(). */
export function parseInstructionStructure(content: string): InstructionStructure {
  const tokens = marked.lexer(content);
  const sections: InstructionSection[] = [];
  const codeBlocks: Array<{ lang: string; code: string }> = [];

  let currentSection: InstructionSection | null = null;
  const contentParts: string[] = [];

  function flushSection() {
    if (currentSection) {
      currentSection.content = contentParts.join("\n").trim();
      sections.push(currentSection);
      contentParts.length = 0;
    }
  }

  for (const token of tokens) {
    if (token.type === "heading") {
      flushSection();
      currentSection = {
        heading: token.text,
        depth: token.depth,
        content: "",
      };
    } else if (token.type === "code") {
      codeBlocks.push({ lang: token.lang ?? "", code: token.text });
      contentParts.push(token.raw);
    } else if (token.type === "space") {
      // skip
    } else {
      contentParts.push(token.raw);
    }
  }
  flushSection();

  // If no headings found, put everything in a single implicit section
  if (sections.length === 0 && content.trim().length > 0) {
    sections.push({ heading: "", depth: 0, content: content.trim() });
  }

  return { sections, codeBlocks, raw: content };
}

interface LoadInstructionOptions {
  homeDir?: string;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function readInstructionFromRoot(
  rootDir: string,
  source: InstructionSource,
  scope: LoadedInstruction["scope"],
): LoadedInstruction | null {
  for (const file of source.files) {
    const fullPath = join(rootDir, file);
    if (!existsSync(fullPath)) continue;

    try {
      const content = readFileSync(fullPath, "utf-8").trim();
      if (content.length > 0) {
        return { source: source.id, file, content, scope };
      }
    } catch {}
    break;
  }

  return null;
}

export function loadInstructions(
  cwd: string,
  enabledIds?: string[],
  opts?: LoadInstructionOptions,
): LoadedInstruction[] {
  const enabled = new Set(
    enabledIds ?? INSTRUCTION_SOURCES.filter((s) => s.defaultEnabled).map((s) => s.id),
  );

  const results: LoadedInstruction[] = [];
  const projectRoot = cwd;
  const globalRoot = opts?.homeDir ?? homedir();
  const hasDistinctGlobalRoot = canonicalPath(globalRoot) !== canonicalPath(projectRoot);

  for (const source of INSTRUCTION_SOURCES) {
    if (!enabled.has(source.id)) continue;

    const projectMatch = readInstructionFromRoot(projectRoot, source, "project");
    const globalMatch = hasDistinctGlobalRoot
      ? readInstructionFromRoot(globalRoot, source, "global")
      : null;
    const sameInstructionFile =
      projectMatch &&
      globalMatch &&
      canonicalPath(join(projectRoot, projectMatch.file)) ===
        canonicalPath(join(globalRoot, globalMatch.file));

    if (projectMatch) results.push(projectMatch);
    if (globalMatch && !sameInstructionFile) results.push(globalMatch);
  }

  return results;
}

export function buildInstructionPrompt(instructions: LoadedInstruction[]): string {
  if (instructions.length === 0) return "";

  const projectInstructions = instructions.filter((inst) => inst.scope === "project");
  const globalInstructions = instructions.filter((inst) => inst.scope === "global");
  const parts: string[] = [];

  if (globalInstructions.length > 0) {
    parts.push(
      "Global instruction files apply across all projects, but project-local instruction files take priority when they conflict.",
    );
  }

  if (globalInstructions.length > 0) {
    const globalParts: string[] = [];
    for (const inst of globalInstructions) {
      globalParts.push(`[global:${inst.file}]\n${inst.content}`);
    }
    parts.push(`Global instruction files:\n${globalParts.join("\n\n")}`);
  }

  if (projectInstructions.length > 0) {
    const projectParts: string[] = [];
    for (const inst of projectInstructions) {
      projectParts.push(
        globalInstructions.length > 0
          ? `[project:${inst.file}]\n${inst.content}`
          : `[${inst.file}]\n${inst.content}`,
      );
    }
    parts.push(
      globalInstructions.length > 0
        ? `Project-local instruction files:\n${projectParts.join("\n\n")}`
        : projectParts.join("\n\n"),
    );
  }

  return `Project instructions:\n${parts.join("\n\n")}`;
}
