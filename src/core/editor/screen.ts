// ScreenSegment is kept for backward compatibility with type references.
// NvimScreen class has been removed — rendering is now handled by ghostty-terminal.

export interface ScreenSegment {
  text: string;
  fg: string;
  bg: string | undefined; // undefined = default/transparent
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
}
