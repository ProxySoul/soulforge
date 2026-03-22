import { Marked, type Tokens } from "marked";
import { codeToAnsi } from "./shiki.js";

const RST = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const UNDERLINE = "\x1b[4m";
const STRIKETHROUGH = "\x1b[9m";
const PURPLE = "\x1b[38;2;155;48;255m";
const BLUE = "\x1b[38;2;126;182;255m";
const GREEN = "\x1b[38;2;195;232;141m";
const YELLOW = "\x1b[38;2;255;203;107m";
const CYAN = "\x1b[38;2;137;221;255m";
const GRAY = "\x1b[38;2;136;136;136m";
const CODE_BG = "\x1b[48;2;30;30;46m";

const HEADING_COLORS = [
  PURPLE, // h1
  PURPLE, // h2
  BLUE, // h3
  CYAN, // h4
  GRAY, // h5
  GRAY, // h6
];

/**
 * Render markdown to ANSI-formatted terminal text.
 * Code blocks are syntax-highlighted via shiki.
 */
export async function renderMarkdownToAnsi(markdown: string): Promise<string> {
  const codeBlocks: Array<{ placeholder: string; lang: string; code: string }> = [];
  let blockIdx = 0;

  // Custom renderer that outputs ANSI-formatted text
  const renderer: Record<string, (...args: unknown[]) => string> = {
    heading(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: unknown) {
      const t = token as Tokens.Heading;
      const text = this.parser.parseInline(t.tokens);
      const color = HEADING_COLORS[t.depth - 1] ?? GRAY;
      const prefix = t.depth <= 2 ? `${"━".repeat(Math.max(1, 4 - t.depth))} ` : "";
      return `\n${color}${BOLD}${prefix}${text}${RST}\n\n`;
    },

    paragraph(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: unknown) {
      const t = token as Tokens.Paragraph;
      return `${this.parser.parseInline(t.tokens)}\n\n`;
    },

    code(_token: unknown) {
      const t = _token as Tokens.Code;
      const placeholder = `\x00CODEBLOCK_${String(blockIdx)}\x00`;
      codeBlocks.push({ placeholder, lang: t.lang ?? "", code: t.text });
      blockIdx++;
      return `${placeholder}\n`;
    },

    blockquote(this: { parser: { parse(tokens: Tokens.Generic[]): string } }, token: unknown) {
      const t = token as Tokens.Blockquote;
      const body = this.parser.parse(t.tokens);
      const lines = body.trimEnd().split("\n");
      const quoted = lines.map((l: string) => `${GRAY}  │${RST} ${ITALIC}${l}${RST}`).join("\n");
      return `${quoted}\n\n`;
    },

    list(this: { listitem(item: Tokens.ListItem, ordered?: boolean): string }, token: unknown) {
      const t = token as Tokens.List;
      const items: string[] = [];
      for (const item of t.items) {
        items.push(this.listitem(item, t.ordered));
      }
      return `${items.join("")}\n`;
    },

    listitem(
      this: { parser: { parse(tokens: Tokens.Generic[]): string } },
      item: unknown,
      ordered: unknown,
    ) {
      const it = item as Tokens.ListItem;
      const text = this.parser.parse(it.tokens).trimEnd();
      const bullet = ordered ? `${YELLOW}  •${RST}` : `${YELLOW}  •${RST}`;
      if (it.task) {
        const check = it.checked ? `${GREEN}✓${RST}` : `${DIM}○${RST}`;
        return `  ${check} ${text}\n`;
      }
      return `${bullet} ${text}\n`;
    },

    hr() {
      return `${DIM}${"─".repeat(40)}${RST}\n\n`;
    },

    table(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: unknown) {
      const t = token as Tokens.Table;
      const rows: string[] = [];
      const headerCells = t.header.map(
        (cell) => `${BOLD}${this.parser.parseInline(cell.tokens)}${RST}`,
      );
      rows.push(`  ${headerCells.join(`${DIM} │ ${RST}`)}`);
      rows.push(`  ${DIM}${"─".repeat(40)}${RST}`);
      for (const row of t.rows) {
        const cells = row.map((cell) => this.parser.parseInline(cell.tokens));
        rows.push(`  ${cells.join(`${DIM} │ ${RST}`)}`);
      }
      return `${rows.join("\n")}\n\n`;
    },

    strong(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: unknown) {
      const t = token as Tokens.Strong;
      return `${BOLD}${this.parser.parseInline(t.tokens)}${RST}`;
    },

    em(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: unknown) {
      const t = token as Tokens.Em;
      return `${ITALIC}${this.parser.parseInline(t.tokens)}${RST}`;
    },

    codespan(token: unknown) {
      const t = token as Tokens.Codespan;
      return `${CODE_BG}${CYAN} ${t.text} ${RST}`;
    },

    del(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: unknown) {
      const t = token as Tokens.Del;
      return `${STRIKETHROUGH}${this.parser.parseInline(t.tokens)}${RST}`;
    },

    link(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: unknown) {
      const t = token as Tokens.Link;
      const text = this.parser.parseInline(t.tokens);
      return `${UNDERLINE}${BLUE}${text}${RST} ${DIM}(${t.href})${RST}`;
    },

    image(token: unknown) {
      const t = token as Tokens.Image;
      return `${DIM}[image: ${t.text ?? t.href}]${RST}`;
    },

    br() {
      return "\n";
    },

    html(token: unknown) {
      const t = token as Tokens.HTML;
      return t.text.replace(/<[^>]*>/g, "");
    },

    text(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: unknown) {
      const t = token as Tokens.Text;
      if ("tokens" in t && t.tokens) {
        return this.parser.parseInline(t.tokens);
      }
      return t.text;
    },

    space() {
      return "\n";
    },
  };

  const marked = new Marked({ renderer, async: false });
  let result = marked.parse(markdown) as string;

  // Replace code block placeholders with shiki-highlighted code
  for (const block of codeBlocks) {
    try {
      const highlighted = await codeToAnsi(block.code, block.lang || undefined);
      const langLabel = block.lang ? `${DIM}${block.lang}${RST}\n` : "";
      const border = `${DIM}${"─".repeat(40)}${RST}`;
      result = result.replace(
        block.placeholder,
        `${langLabel}${border}\n${CODE_BG}${highlighted}${RST}\n${border}`,
      );
    } catch {
      result = result.replace(block.placeholder, block.code);
    }
  }

  // Clean up excessive newlines
  result = result.replace(/\n{3,}/g, "\n\n").trim();

  return result;
}
