/**
 * The accent palette a client is set to — a choice that lives alongside
 * light/dark rather than replacing it: each palette defines both.
 *
 * Shared so the two clients can't drift on names or on which one is default.
 * The colours themselves are NOT here: the web's live in CSS custom properties
 * (index.css) and the phone's in a StyleSheet-friendly object (theme.ts),
 * because neither can consume the other's format.
 */
export const PALETTES = [
  {
    key: "amber",
    label: "Amber",
    description: "Warm golden-hour accent. The default.",
  },
  {
    key: "linen",
    label: "Linen",
    description: "Near-monochrome: cream on dark, ink on light.",
  },
] as const;

export type PaletteKey = (typeof PALETTES)[number]["key"];

export const DEFAULT_PALETTE: PaletteKey = "amber";

/** Coerce anything read back from storage into a palette we actually ship. */
export function resolvePalette(value: string | null | undefined): PaletteKey {
  return PALETTES.some((p) => p.key === value) ? (value as PaletteKey) : DEFAULT_PALETTE;
}
