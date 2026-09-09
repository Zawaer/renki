import { DEFAULT_PALETTE, type PaletteKey } from "@renki/client-core";
import { createContext, useContext, useMemo } from "react";
import { useColorScheme } from "react-native";

/**
 * Warm, softly-rounded dark/light palettes styled after the native Claude
 * app (rounded pills and cards, near-black/near-white surfaces, minimal hard
 * borders) rather than mobile's original VS Code Dark+/Light+ mirror — that
 * flat, sharp-cornered, thin-border look reads as a code editor, not a phone
 * app. Web/VS Code keep their own --renki-* mirror; this palette is
 * mobile-only.
 */
/**
 * The web app's "golden-hour" palette, converted from its oklch tokens (see
 * apps/web/src/index.css) to hex because React Native can't parse oklch.
 *
 * Kept in step with the web deliberately: Renki is one product seen from a
 * phone, a browser and an editor, and until now the phone was warm-grey with a
 * BLUE accent while the web had gone amber — the same session looked like two
 * different apps. Surfaces run darkest to lightest: inset < bg ≈ bgElevated <
 * panel, with hierarchy from tone and spacing rather than borders.
 */
const darkColors = {
  bg: "#16100b",
  /** Almost the page colour — for bars and headers that shouldn't read as panels. */
  bgElevated: "#19120d",
  /** Cards, sheets, the composer. */
  panel: "#231b14",
  /** Pressed/hover tone; also the old `panel2`. */
  hover: "#282019",
  /** Wells: meter tracks, code blocks, inputs. */
  inset: "#0f0a06",
  border: "#29231c",
  text: "#f5ede1",
  dim: "#a89c8f",
  faint: "#797065",
  accent: "#ec9d53",
  accentHover: "#f9aa60",
  /** Dark text on the amber accent — the accent is light, so white would smear. */
  accentFg: "#2f1000",
  selectedFg: "#fbf4ea",
  link: "#86b9d8",
  inputBg: "#110c08",
  ok: "#5ad791",
  busy: "#f4c855",
  error: "#ea6b62",
  danger: "#ea6b62",
  chartInput: "#62aedb",
  chartOutput: "#ec9d53",
};

const lightColors: typeof darkColors = {
  bg: "#fbf8f2",
  bgElevated: "#f9f6f1",
  panel: "#ffffff",
  hover: "#efebe2",
  inset: "#f4f0e7",
  border: "#e8e4dd",
  text: "#2d2118",
  dim: "#71675d",
  faint: "#9e978f",
  accent: "#d27830",
  accentHover: "#c56c21",
  accentFg: "#fffbf4",
  selectedFg: "#2d2118",
  link: "#266ea4",
  inputBg: "#ffffff",
  ok: "#0e9254",
  busy: "#c78b09",
  error: "#c83a37",
  danger: "#c83a37",
  chartInput: "#3077ad",
  chartOutput: "#d27830",
};

export type ThemeColors = typeof darkColors;

/**
 * The accent-only overlays for each palette, converted from the web's
 * data-palette blocks (apps/web/src/index.css).
 *
 * "linen" swaps the amber for the app's own near-white/near-black pair, which
 * means it inverts between light and dark: a cream button reads on a dark
 * ground and vanishes on a light one. `selected` comes off the text colour
 * rather than the accent for the same reason — a 12% tint of cream is a
 * colourless wash.
 */
const PALETTE_OVERRIDES: Record<PaletteKey, { dark: Partial<ThemeColors>; light: Partial<ThemeColors> }> = {
  amber: { dark: {}, light: {} },
  linen: {
    dark: { accent: "#efe8da", accentHover: "#fbf6ec", accentFg: "#16100b", chartOutput: "#efe8da" },
    light: { accent: "#2d2118", accentHover: "#3d2f23", accentFg: "#fbf8f2", chartOutput: "#2d2118" },
  },
};

/**
 * The palette this device is set to, held in context so changing it in
 * Settings re-renders every screen — `useTheme` is called from all of them,
 * and a module-level variable would leave the app half-repainted until
 * navigation.
 */
const PaletteContext = createContext<PaletteKey>(DEFAULT_PALETTE);
export const PaletteProvider = PaletteContext.Provider;

export function useTheme(): ThemeColors {
  const scheme = useColorScheme();
  const palette = useContext(PaletteContext);
  const base = scheme === "light" ? lightColors : darkColors;
  const overlay = PALETTE_OVERRIDES[palette][scheme === "light" ? "light" : "dark"];
  return useMemo(() => ({ ...base, ...overlay }), [base, overlay]);
}

export function statusColorFor(colors: ThemeColors): Record<string, string> {
  return {
    idle: colors.ok,
    busy: colors.busy,
    error: colors.error,
    archived: colors.faint,
    trashed: colors.faint,
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
