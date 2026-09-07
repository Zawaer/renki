import { describe, expect, it } from "vitest";
import { estimateTokens, formatTokenCount } from "../src/tokens.js";

describe("formatTokenCount", () => {
  it("shows small counts exactly", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(1)).toBe("1");
    expect(formatTokenCount(812)).toBe("812");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("keeps one decimal below ten of a unit, where it carries information", () => {
    expect(formatTokenCount(1000)).toBe("1.0k");
    expect(formatTokenCount(1234)).toBe("1.2k");
    expect(formatTokenCount(9949)).toBe("9.9k");
  });

  it("drops the decimal above ten of a unit, where it's noise", () => {
    expect(formatTokenCount(35_752)).toBe("36k");
    expect(formatTokenCount(398_000)).toBe("398k");
    expect(formatTokenCount(999_499)).toBe("999k");
  });

  it("steps up to millions instead of letting thousands run away", () => {
    // The bug this fixes: a lifetime total used to read "35752k".
    expect(formatTokenCount(35_752_000)).toBe("36M");
    expect(formatTokenCount(1_000_000)).toBe("1.0M");
    expect(formatTokenCount(9_500_000)).toBe("9.5M");
    expect(formatTokenCount(44_300_000)).toBe("44M");
  });

  it("steps up again at a billion", () => {
    expect(formatTokenCount(1_500_000_000)).toBe("1.5B");
    expect(formatTokenCount(23_000_000_000)).toBe("23B");
  });

  it("handles a negative (a delta) without mangling the unit", () => {
    expect(formatTokenCount(-1500)).toBe("-1.5k");
  });
});

describe("estimateTokens", () => {
  it("is a rough chars-over-four estimate, never negative", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});
