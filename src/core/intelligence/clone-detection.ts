const KEYWORDS = new Set([
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "break",
  "continue",
  "return",
  "throw",
  "try",
  "catch",
  "finally",
  "new",
  "delete",
  "typeof",
  "instanceof",
  "in",
  "of",
  "class",
  "extends",
  "implements",
  "interface",
  "enum",
  "const",
  "let",
  "var",
  "function",
  "async",
  "await",
  "yield",
  "import",
  "export",
  "from",
  "default",
  "static",
  "public",
  "private",
  "protected",
  "abstract",
  "override",
  "readonly",
  "void",
  "null",
  "undefined",
  "true",
  "false",
  "this",
  "super",
  "def",
  "self",
  "fn",
  "pub",
  "mut",
  "impl",
  "struct",
  "trait",
  "mod",
  "use",
  "crate",
  "match",
  "loop",
  "func",
  "go",
  "chan",
  "select",
  "defer",
  "range",
  "type",
  "package",
  "raise",
  "except",
  "pass",
  "lambda",
  "with",
  "as",
  "is",
  "not",
  "and",
  "or",
  "None",
  "True",
  "False",
]);

const TOKEN_RE =
  /[a-zA-Z_$]\w*|0[xXbBoO][\da-fA-F_]+|\d[\d_.]*(?:[eE][+-]?\d+)?[fFdDlLuU]?|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|[^\s\w]/g;

function normalizeToken(token: string): string {
  if (token.length === 0) return token;
  const first = token[0] as string;
  if (first === '"' || first === "'" || first === "`") return "$S";
  if (/^\d/.test(token) || /^0[xXbBoO]/.test(token)) return "$N";
  if (/^[a-zA-Z_$]/.test(token)) {
    return KEYWORDS.has(token) ? token : "$I";
  }
  return token;
}

export function tokenize(source: string): string[] {
  const tokens: string[] = [];
  for (const match of source.matchAll(TOKEN_RE)) {
    tokens.push(normalizeToken(match[0]));
  }
  return tokens;
}

const NUM_HASHES = 128;
const SHINGLE_K = 3;

export function computeMinHash(tokens: string[]): Uint32Array | null {
  if (tokens.length < SHINGLE_K + 2) return null;

  const sig = new Uint32Array(NUM_HASHES);
  sig.fill(0xffffffff);

  const shingleCount = tokens.length - SHINGLE_K + 1;
  for (let s = 0; s < shingleCount; s++) {
    const shingle = `${tokens[s]}\0${tokens[s + 1]}\0${tokens[s + 2]}`;

    for (let h = 0; h < NUM_HASHES; h++) {
      const v = Number(BigInt(Bun.hash(`${String(h)}\x01${shingle}`)) & 0xffffffffn);
      if (v < (sig[h] as number)) sig[h] = v;
    }
  }

  return sig;
}

export function jaccardSimilarity(a: Uint32Array, b: Uint32Array): number {
  let matches = 0;
  for (let i = 0; i < NUM_HASHES; i++) {
    if (a[i] === b[i]) matches++;
  }
  return matches / NUM_HASHES;
}

const FRAGMENT_WINDOW = 12;
const MIN_FRAGMENT_TOKENS = FRAGMENT_WINDOW + 4;

export interface FragmentHash {
  hash: string;
  tokenOffset: number;
}

export function computeFragmentHashes(tokens: string[]): FragmentHash[] {
  if (tokens.length < MIN_FRAGMENT_TOKENS) return [];

  const results: FragmentHash[] = [];
  const windowCount = tokens.length - FRAGMENT_WINDOW + 1;
  for (let i = 0; i < windowCount; i++) {
    const window = tokens.slice(i, i + FRAGMENT_WINDOW).join("\0");
    const hash = Bun.hash(window).toString(16);
    results.push({ hash, tokenOffset: i });
  }

  return results;
}

export { FRAGMENT_WINDOW, NUM_HASHES };
