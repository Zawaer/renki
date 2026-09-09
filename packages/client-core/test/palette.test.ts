import { describe, expect, it } from "vitest";
import { DEFAULT_PALETTE, PALETTES, resolvePalette } from "../src/palette.js";

describe("resolvePalette", () => {
  it("keeps a palette we ship", () => {
    expect(resolvePalette("linen")).toBe("linen");
    expect(resolvePalette("amber")).toBe("amber");
  });

  /** Storage is a string from a previous version, a different client, or a typo. */
  it("falls back to amber for anything else", () => {
    for (const junk of [null, undefined, "", "AMBER", "clay", "dark"]) {
      expect(resolvePalette(junk), String(junk)).toBe(DEFAULT_PALETTE);
    }
  });

  it("ships amber first, since that's the default a new client shows", () => {
    expect(PALETTES[0].key).toBe(DEFAULT_PALETTE);
  });
});
