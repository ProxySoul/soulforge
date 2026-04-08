import { getThemeTokens } from "../theme/index.js";

export const WORDMARK = [
  "╔═╗╔═╗╦ ╦╦  ╔═╗╔═╗╦═╗╔═╗╔═╗",
  "╚═╗║ ║║ ║║  ╠╣ ║ ║╠╦╝║ ╦╠╣ ",
  "╚═╝╚═╝╚═╝╩═╝╚  ╚═╝╩╚═╚═╝╚═╝",
];

const GLITCH_POOL = "░▒▓█▄▀▐▌┤├┼─│┌┐└┘╔╗╚╝";

export const WISP_FRAMES = ["~∿~", "∿~∿", "·∿·", "∿·∿"];

export function garble(text: string): string {
  return [...text]
    .map((ch) =>
      ch === " " ? " " : (GLITCH_POOL[Math.floor(Math.random() * GLITCH_POOL.length)] ?? "█"),
    )
    .join("");
}

export interface BrandSegment {
  text: string;
  color: string;
}

/** Theme-aware brand segments — reads active theme at call time */
export function getBrandSegments(): BrandSegment[] {
  const t = getThemeTokens();
  return [
    { text: "by ", color: t.textSecondary },
    { text: "Proxy", color: t.brand },
    { text: "Soul", color: t.brandSecondary },
    { text: ".com", color: t.textSecondary },
  ];
}
