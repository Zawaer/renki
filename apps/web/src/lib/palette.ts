import { resolvePalette, type PaletteKey } from "@renki/client-core";

/**
 * The accent palette, stamped on <html data-palette> for index.css to pick up.
 *
 * Applied from main.tsx before React renders rather than from a component:
 * setting it after first paint means the amber default is briefly visible to
 * someone who chose linen, which is exactly the flash a stored preference is
 * supposed to prevent.
 */
const KEY = "renki.palette";

export function loadPalette(): PaletteKey {
  try {
    return resolvePalette(localStorage.getItem(KEY));
  } catch {
    return resolvePalette(null);
  }
}

export function applyPalette(palette: PaletteKey): void {
  document.documentElement.dataset.palette = palette;
}

export function savePalette(palette: PaletteKey): void {
  try {
    localStorage.setItem(KEY, palette);
  } catch {
    // Private mode: the choice still applies for this session.
  }
  applyPalette(palette);
}
