import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  addDefaultParsers,
  type FiletypeParserOptions,
  getTreeSitterClient,
  SyntaxStyle,
  type ThemeTokenStyle,
} from "@opentui/core";

const IS_BUNDLED = import.meta.url.includes("$bunfs");
const bundledAssets = join(homedir(), ".soulforge", "opentui-assets");
let coreAssetsDir: string;
if (IS_BUNDLED) {
  coreAssetsDir = bundledAssets;
} else {
  try {
    coreAssetsDir = resolve(dirname(require.resolve("@opentui/core")), "assets");
  } catch {
    coreAssetsDir = bundledAssets;
  }
  if (!existsSync(coreAssetsDir)) coreAssetsDir = bundledAssets;
}

const tsHighlights = [resolve(coreAssetsDir, "typescript/highlights.scm")];
const tsWasm = resolve(coreAssetsDir, "typescript/tree-sitter-typescript.wasm");
const jsHighlights = [resolve(coreAssetsDir, "javascript/highlights.scm")];
const jsWasm = resolve(coreAssetsDir, "javascript/tree-sitter-javascript.wasm");

const aliases: FiletypeParserOptions[] = [
  { filetype: "ts", queries: { highlights: tsHighlights }, wasm: tsWasm },
  { filetype: "tsx", queries: { highlights: tsHighlights }, wasm: tsWasm },
  { filetype: "js", queries: { highlights: jsHighlights }, wasm: jsWasm },
  { filetype: "jsx", queries: { highlights: jsHighlights }, wasm: jsWasm },
  { filetype: "typescriptreact", queries: { highlights: tsHighlights }, wasm: tsWasm },
  { filetype: "javascriptreact", queries: { highlights: jsHighlights }, wasm: jsWasm },
];

addDefaultParsers(aliases);

const theme: ThemeTokenStyle[] = [
  { scope: ["default"], style: { foreground: "#aaa" } },
  { scope: ["conceal"], style: { foreground: "#444" } },
  { scope: ["markup.strong"], style: { foreground: "#ccc", bold: true } },
  { scope: ["markup.italic"], style: { foreground: "#bbb", italic: true } },
  { scope: ["markup.strikethrough"], style: { foreground: "#666", dim: true } },
  { scope: ["markup.raw"], style: { foreground: "#c792ea" } },
  { scope: ["markup.heading"], style: { foreground: "#9B30FF", bold: true } },
  { scope: ["markup.heading.1"], style: { foreground: "#9B30FF", bold: true } },
  { scope: ["markup.heading.2"], style: { foreground: "#9B30FF", bold: true } },
  { scope: ["markup.heading.3"], style: { foreground: "#9B30FF", bold: true } },
  { scope: ["markup.link.label"], style: { foreground: "#7eb6ff" } },
  { scope: ["markup.link.url", "markup.link"], style: { foreground: "#555" } },
  { scope: ["markup.list"], style: { foreground: "#f0c674" } },
  { scope: ["markup.list.checked"], style: { foreground: "#2d5" } },
  { scope: ["markup.list.unchecked"], style: { foreground: "#555" } },
  { scope: ["markup.quote"], style: { foreground: "#888", italic: true } },
  { scope: ["keyword", "keyword.control"], style: { foreground: "#c792ea" } },
  { scope: ["keyword.operator", "operator"], style: { foreground: "#89ddff" } },
  { scope: ["string"], style: { foreground: "#c3e88d" } },
  { scope: ["string.escape"], style: { foreground: "#89ddff" } },
  { scope: ["comment"], style: { foreground: "#555" } },
  { scope: ["number", "constant", "constant.builtin"], style: { foreground: "#f78c6c" } },
  { scope: ["type", "type.builtin"], style: { foreground: "#ffcb6b" } },
  { scope: ["function", "function.method"], style: { foreground: "#82aaff" } },
  { scope: ["variable", "variable.builtin"], style: { foreground: "#f07178" } },
  { scope: ["property"], style: { foreground: "#bbb" } },
  {
    scope: ["punctuation", "punctuation.bracket", "punctuation.delimiter"],
    style: { foreground: "#888" },
  },
  { scope: ["punctuation.special"], style: { foreground: "#89ddff" } },
  { scope: ["tag"], style: { foreground: "#f07178" } },
  { scope: ["attribute"], style: { foreground: "#ffcb6b" } },
  { scope: ["label"], style: { foreground: "#82aaff" } },
  { scope: ["character.special"], style: { foreground: "#89ddff" } },
  { scope: ["markup.raw.block"], style: { foreground: "#aaa" } },
];

let _syntaxStyle: SyntaxStyle | null = null;
export function getSyntaxStyle(): SyntaxStyle {
  if (!_syntaxStyle) _syntaxStyle = SyntaxStyle.fromTheme(theme);
  return _syntaxStyle;
}

let _tsClient: ReturnType<typeof getTreeSitterClient> | null = null;
export function getTSClient() {
  if (!_tsClient) {
    _tsClient = getTreeSitterClient();
    _tsClient.initialize();
  }
  return _tsClient;
}
