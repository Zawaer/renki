import { afterEach, describe, expect, it } from "vitest";
import { applyPalette, loadPalette, savePalette } from "../src/lib/palette.js";

/**
 * The palette is stamped on <html data-palette> for index.css to key off, and
 * read back from localStorage before first paint (see main.tsx). Both halves
 * are worth pinning: a wrong attribute name silently leaves everyone on amber,
 * which looks like the feature simply not working.
 */
afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.palette;
});

describe("palette preference", () => {
  it("defaults to amber when nothing is stored", () => {
    expect(loadPalette()).toBe("amber");
  });

  it("round-trips a choice and stamps it on the document", () => {
    savePalette("linen");
    expect(localStorage.getItem("renki.palette")).toBe("linen");
    expect(document.documentElement.dataset.palette).toBe("linen");
    expect(loadPalette()).toBe("linen");
  });

  /** A value from a future version, a hand-edited key, or a typo must not leave the app unstyled. */
  it("falls back to amber for a stored value it doesn't recognise", () => {
    localStorage.setItem("renki.palette", "chartreuse");
    expect(loadPalette()).toBe("amber");
  });

  it("applyPalette alone sets the attribute without writing storage", () => {
    applyPalette("linen");
    expect(document.documentElement.dataset.palette).toBe("linen");
    expect(localStorage.getItem("renki.palette")).toBeNull();
  });
});
