export const BRAND_PURPLE = "#9B30FF";
export const BRAND_RED = "#FF0040";

export const WORDMARK = [
  "┌─┐┌─┐┬ ┬┬  ┌─┐┌─┐┬─┐┌─┐┌─┐",
  "└─┐│ ││ ││  ├┤ │ │├┬┘│ ┬├┤ ",
  "└─┘└─┘└─┘┴─┘└  └─┘┴└─└─┘└─┘",
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

export const BRAND_SEGMENTS: BrandSegment[] = [
  { text: "by ", color: "#555555" },
  { text: "Proxy", color: BRAND_PURPLE },
  { text: "Soul", color: BRAND_RED },
  { text: ".com", color: "#555555" },
];
