// Decorative glyphs prefixing workflows (⇉) and schedules (⏱). pi-tui
// computes their width from Unicode tables (1 cell), but terminals fall
// back to another font for codepoints the primary monospace font lacks,
// and that fallback can render at a different cell count or offset,
// misaligning the row (e.g. kitty + JetBrainsMono Nerd Font lacks both).
// `showGlyphs: false` in pi-minion.json drops them everywhere instead.
let show = true;

export function setShowGlyphs(value: boolean | undefined): void {
  show = value ?? true;
}

// The glyphs, or "" when showGlyphs is disabled.
export function glyph(text: string): string {
  return show ? text : "";
}
