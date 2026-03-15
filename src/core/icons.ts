import { getProvider } from "./llm/providers/index.js";

const NERD: Record<string, string> = {
  ghost: "󰊠",
  editor: "󰞍",
  pencil: "\uF044",
  chat: "󰍩",
  folder: "󰉋",
  brain: "󰘦",
  brain_alt: "\uDB80\uDE26",
  user: "󰀄",
  ai: "󰚩",
  system: "󰒓",
  tokens: "󰨇",
  sparkle: "󰩟",
  arrow: "󰅂",
  arrow_right: "\uF0A9",
  clock: "󰥔",
  clock_alt: "\uF017",
  git: "󰊢",
  tools: "󰠭",
  wrench: "\uF0AD",
  plan: "\uF0CB",
  question: "\uF059",
  changes: "\uF07C",
  search: "\uF002",
  check: "\uF058",
  spinner: "\uDB80\uDD31",
  skip: "\uDB80\uDD56",
  trash: "\uDB80\uDDB4",
  clear: "\uF01B4",
  skills: "\uDB82\uDD2A",
  cog: "\uF013",
  error: "\uF06A",
  warning: "\uF071",
  quit: "\uF08B",
  stop: "\uF04D",
  play: "\uF04E",
  compress: "\uF066",
  context: "\uF1C0",
  lock: "\uF023",
  proxy: "󰌆",
  vercel_gateway: "󰒍",
  panel: "\uDB82\uDD28",
  file: "\uDB80\uDCCB",
  terminal: "\uF120",
  globe: "\uF0AC",
  bookmark: "\uF02E",
  trash_alt: "\uF1F8",
  code: "\uDB80\uDD69",
  references: "\uDB80\uDD39",
  definition: "\uDB80\uDC6E",
  actions: "\uDB80\uDC68",
  rename: "󰑕",
  format: "󰉣",
  lightning: "\uF0E7",
  explore: "\uDB80\uDE29",
  memory: "󰍽",
  memory_alt: "\uDB80\uDDA3",
  dispatch: "󰚩",
  router: "󰓹",
  tabs: "󰓩",
  info: "󰋖",
  powerline_left: "\uE0B6",
  powerline_right: "\uE0B4",
  help: "\uF059",
  repomap: "󰙅",
  storage: "󰋊",
  delete_all: "󰩺",
  chat_style: "󰍪",
  budget: "󰊕",
  verbose: "󰍡",
  compact: "󰁜",
  ban: "󰒃",
  web_search: "󰖟",
  check_link: "󰄬",
  nvim: "\uDB80\uDFA9",
  model: "󰧑",
  gear: "󰣖",
  gauge: "󰊕",
  cache: "󰑮",
  trivial: "󰓅",
  cleanup: "󰤌",
  investigate: "\uDB80\uDF50",
};

const ASCII: Record<string, string> = {
  ghost: "◆",
  editor: "✎",
  pencil: "✎",
  chat: "▸",
  folder: "/",
  brain: "⚙",
  brain_alt: "⚙",
  user: "●",
  ai: "▹",
  system: "⚙",
  tokens: "⚡",
  sparkle: "✦",
  arrow: "›",
  arrow_right: "→",
  clock: "◷",
  clock_alt: "◷",
  git: "⎇",
  tools: "⚒",
  wrench: "⚒",
  plan: "☰",
  question: "?",
  changes: "△",
  search: "⌕",
  check: "✓",
  spinner: "○",
  skip: "⊘",
  trash: "✕",
  clear: "⌫",
  skills: "★",
  cog: "⚙",
  error: "✕",
  warning: "⚠",
  quit: "⏻",
  stop: "■",
  play: "▶",
  compress: "↕",
  context: "◉",
  lock: "🔒",
  proxy: "⛨",
  vercel_gateway: "☁",
  panel: "▣",
  file: "□",
  terminal: "$",
  globe: "⊕",
  bookmark: "⊡",
  trash_alt: "✕",
  code: "{}",
  references: "⇉",
  definition: "⊳",
  actions: "⚡",
  rename: "✎",
  format: "≡",
  lightning: "⚡",
  explore: "◎",
  memory: "✿",
  memory_alt: "✿",
  dispatch: "▹",
  router: "⚙",
  tabs: "☰",
  info: "ⓘ",
  powerline_left: "│",
  powerline_right: "│",
  help: "?",
  repomap: "◈",
  storage: "▪",
  delete_all: "✕",
  chat_style: "◇",
  budget: "◎",
  verbose: "◉",
  compact: "↕",
  ban: "⊘",
  web_search: "⊕",
  check_link: "✓",
  nvim: "✎",
  model: "⚙",
  gear: "⚙",
  gauge: "◎",
  cache: "⚡",
  trivial: "↯",
  cleanup: "♻",
  investigate: "◎",
};

let _nerdFont: boolean | null = null;

export function initNerdFont(configValue?: boolean | null): void {
  if (configValue === true || configValue === false) {
    _nerdFont = configValue;
  } else {
    _nerdFont = false;
  }
}

export function hasNerdFont(): boolean {
  if (_nerdFont === null) {
    _nerdFont = false;
  }
  return _nerdFont;
}

export function setNerdFont(value: boolean): void {
  _nerdFont = value;
}

export function icon(name: string): string {
  const set = hasNerdFont() ? NERD : ASCII;
  return set[name] ?? name;
}

export const UI_ICONS = {
  get ghost() {
    return icon("ghost");
  },
  get editor() {
    return icon("editor");
  },
  get chat() {
    return icon("chat");
  },
  get folder() {
    return icon("folder");
  },
  get brain() {
    return icon("brain");
  },
  get user() {
    return icon("user");
  },
  get ai() {
    return icon("ai");
  },
  get system() {
    return icon("system");
  },
  get tokens() {
    return icon("tokens");
  },
  get sparkle() {
    return icon("sparkle");
  },
  get arrow() {
    return icon("arrow");
  },
  get clock() {
    return icon("clock");
  },
  get git() {
    return icon("git");
  },
  get tools() {
    return icon("tools");
  },
};

function inferProviderId(idOrModel: string): string {
  const p = getProvider(idOrModel);
  if (p) return idOrModel;
  const id = idOrModel.toLowerCase();
  if (id.startsWith("claude")) return "anthropic";
  if (
    id.startsWith("gpt") ||
    id.startsWith("o1") ||
    id.startsWith("o3") ||
    id.startsWith("o4") ||
    id.startsWith("chatgpt")
  )
    return "openai";
  if (id.startsWith("gemini")) return "google";
  if (id.startsWith("grok")) return "xai";
  if (id.startsWith("llama") || id.startsWith("meta-")) return "ollama";
  if (id.startsWith("mistral") || id.startsWith("codestral") || id.startsWith("pixtral"))
    return "mistral";
  if (id.startsWith("deepseek")) return "deepseek";
  if (id.includes("/")) return "vercel_gateway";
  return idOrModel;
}

const PROVIDER_ASCII: Record<string, string> = {
  anthropic: "A",
  openai: "O",
  google: "G",
  xai: "X",
  ollama: "🦙",
  proxy: "⛨",
  openrouter: "⊕",
  vercel_gateway: "☁",
  llmgateway: "☁",
  mistral: "M",
  deepseek: "D",
};

export function providerIcon(providerId: string): string {
  const resolved = inferProviderId(providerId);
  if (hasNerdFont()) {
    return getProvider(resolved)?.icon ?? "●";
  }
  return PROVIDER_ASCII[resolved] ?? "●";
}
