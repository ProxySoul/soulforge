import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface InstructionSource {
  id: string;
  label: string;
  files: string[];
  defaultEnabled: boolean;
}

export const INSTRUCTION_SOURCES: InstructionSource[] = [
  {
    id: "soulforge",
    label: "SOULFORGE.md",
    files: ["SOULFORGE.md", ".soulforge/instructions.md"],
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
    id: "opencode",
    label: ".opencode/instructions.md",
    files: [".opencode/instructions.md"],
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
}

export function loadInstructions(cwd: string, enabledIds?: string[]): LoadedInstruction[] {
  const enabled = new Set(
    enabledIds ?? INSTRUCTION_SOURCES.filter((s) => s.defaultEnabled).map((s) => s.id),
  );

  const results: LoadedInstruction[] = [];

  for (const source of INSTRUCTION_SOURCES) {
    if (!enabled.has(source.id)) continue;

    for (const file of source.files) {
      const fullPath = join(cwd, file);
      if (!existsSync(fullPath)) continue;

      try {
        const content = readFileSync(fullPath, "utf-8").trim();
        if (content.length > 0) {
          results.push({ source: source.id, file, content });
        }
      } catch {}
      break;
    }
  }

  return results;
}

export function buildInstructionPrompt(instructions: LoadedInstruction[]): string {
  if (instructions.length === 0) return "";

  const parts: string[] = [];
  for (const inst of instructions) {
    parts.push(`[${inst.file}]\n${inst.content}`);
  }
  return `Project instructions:\n${parts.join("\n\n")}`;
}
