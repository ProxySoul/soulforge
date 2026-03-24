/**
 * Soul Map content builder.
 * The Soul Map is injected as a user message (aider pattern) — models treat
 * user content as context to reference, keeping it separate from instructions.
 *
 * The map is rebuilt after every edit (uncached), while the system prompt
 * stays stable (cached). This separation is key for prompt caching efficiency.
 */
import { walkDir } from "../../context/file-tree.js";

const SOUL_MAP_DESCRIPTION = `This is the Soul Map — a live structural index of the entire codebase.
It is rebuilt automatically after every edit using AST parsing (tree-sitter), PageRank file ranking, and git co-change analysis.

What each part means:
- Files are ranked by importance (highest-impact files first)
- (→N) after a file = blast radius — N other files depend on it
- + before a symbol = exported (part of the public API)
- ← arrows = "imported by" — shows which files depend on this one
- Signatures show function/type shapes so you can understand APIs without reading files
- Key dependencies section shows external packages and how widely they're used`;

const SOUL_MAP_USAGE = `This map answers most structural questions directly:
- "Where is X?" → find the file and line in the map
- "What does file Y export?" → listed under that file
- "What depends on Z?" → check the ← arrows and blast radius
- "What packages does this project use?" → Key dependencies section

For deeper questions, feed symbol names from the map into navigate() or analyze().
The map gives you the names, LSP gives you the details.`;

const LEGEND = "+ = exported. (→N) = blast radius. [NEW] = new since last render.\n";
const DIR_TREE_DEPTH = 2;
const DIR_TREE_LIMIT = 60;

/**
 * Build a shallow directory tree (2 levels deep) for project structure overview.
 * Complements the Soul Map's file-level detail with directory-level context.
 */
export function buildDirectoryTree(cwd: string): string | null {
  const lines: string[] = [];
  walkDir(cwd, "", DIR_TREE_DEPTH, lines);
  if (lines.length === 0) return null;
  const trimmed = lines.length > DIR_TREE_LIMIT ? lines.slice(0, DIR_TREE_LIMIT) : lines;
  return (
    trimmed.join("\n") +
    (lines.length > DIR_TREE_LIMIT ? `\n... (${String(lines.length - DIR_TREE_LIMIT)} more)` : "")
  );
}

export function buildSoulMapUserMessage(
  rendered: string,
  isMinimal: boolean,
  dirTree?: string | null,
): string {
  const legend = isMinimal ? "" : LEGEND;
  const treeSection = dirTree ? `\n<directory_tree>\n${dirTree}\n</directory_tree>\n` : "";
  return (
    `<soul_map>\n` +
    `<description>\n${SOUL_MAP_DESCRIPTION}\n</description>\n\n` +
    `<how_to_use>\n${SOUL_MAP_USAGE}\n</how_to_use>\n${treeSection}\n` +
    `<data>\n${legend}${rendered}\n</data>\n` +
    `</soul_map>`
  );
}

export function buildSoulMapAck(): string {
  return "Soul Map loaded. I'll reference it for file paths, symbols, and dependencies before making tool calls.";
}
