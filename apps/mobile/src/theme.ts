import { useColorScheme } from "react-native";

/**
 * Two palettes modeled on VS Code Dark+ / Light+, mirroring the --crc-* tokens
 * used by apps/web's index.css so the phone app and the VS Code webview read
 * as the same product. Picked at render time by useTheme() via the OS's
 * light/dark preference (mobile is never actually hosted inside VS Code, so
 * there's no live --vscode-* theme to track here).
 */
const darkColors = {
  bg: "#1e1e1e",
  panel: "#252526",
  panel2: "#2d2d2d",
  border: "#3c3c3c",
  text: "#cccccc",
  dim: "#9d9d9d",
  faint: "#6f6f6f",
  accent: "#0078d4",
  accentFg: "#ffffff",
  ok: "#89d185",
  busy: "#cca700",
  error: "#f14c4c",
  danger: "#f14c4c",
  chartInput: "#3987e5",
  chartOutput: "#d95926",
};

const lightColors = {
  bg: "#ffffff",
  panel: "#f3f3f3",
  panel2: "#ececec",
  border: "#e5e5e5",
  text: "#3b3b3b",
  dim: "#717171",
  faint: "#9a9a9a",
  accent: "#007acc",
  accentFg: "#ffffff",
  ok: "#388a34",
  busy: "#bf8803",
  error: "#cd3131",
  danger: "#cd3131",
  chartInput: "#2a78d6",
  chartOutput: "#eb6834",
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
