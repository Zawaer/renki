import { useColorScheme } from "react-native";

/**
 * Warm, softly-rounded dark/light palettes styled after the native Claude
 * app (rounded pills and cards, near-black/near-white surfaces, minimal hard
 * borders) rather than mobile's original VS Code Dark+/Light+ mirror — that
 * flat, sharp-cornered, thin-border look reads as a code editor, not a phone
 * app. Web/VS Code keep their own --crc-* mirror; this palette is
 * mobile-only.
 */
const darkColors = {
  bg: "#191918",
  panel: "#222220",
  panel2: "#2a2a28",
  border: "#34342f",
  text: "#eeeeec",
  dim: "#a9a9a3",
  faint: "#78786f",
  accent: "#5b9dfa",
  accentFg: "#ffffff",
  ok: "#7fd88f",
  busy: "#e0a940",
  error: "#f1685f",
  danger: "#f1685f",
  chartInput: "#5b9dfa",
  chartOutput: "#e0894a",
};

const lightColors = {
  bg: "#faf9f6",
  panel: "#ffffff",
  panel2: "#f1efe9",
  border: "#e8e5dd",
  text: "#2b2a26",
  dim: "#6f6d64",
  faint: "#9c998e",
  accent: "#2f6fed",
  accentFg: "#ffffff",
  ok: "#3a8a4a",
  busy: "#a4720a",
  error: "#d1453a",
  danger: "#d1453a",
  chartInput: "#2f6fed",
  chartOutput: "#c1631f",
};

export type ThemeColors = typeof darkColors;

export function useTheme(): ThemeColors {
  const scheme = useColorScheme();
  return scheme === "light" ? lightColors : darkColors;
}

export function statusColorFor(colors: ThemeColors): Record<string, string> {
  return {
    idle: colors.ok,
    busy: colors.busy,
    error: colors.error,
    archived: colors.faint,
  };
}

/** Tints a `#rrggbb` theme color for translucent overlay backgrounds. */
export function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Shared corner-radius scale — soft/rounded throughout, no more 2px sharp corners. */
export const radius = {
  xs: 8,
  sm: 12,
  md: 16,
  lg: 22,
  xl: 28,
  pill: 999,
};

/** A soft elevation shadow for floating surfaces (composer, sheets, cards). */
export function softShadow(colors: ThemeColors) {
  return {
    shadowColor: colors === darkColors ? "#000" : "#5c5850",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: colors === darkColors ? 0.35 : 0.12,
    shadowRadius: 10,
    elevation: 4,
  };
}
