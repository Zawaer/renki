import { describe, expect, it } from "vitest";
import { DEFAULT_EFFORT_KEY, EFFORT_LEVELS, resolveEffortKey } from "../src/effort.js";

describe("resolveEffortKey", () => {
  it("passes through every known effort key", () => {
    for (const effort of EFFORT_LEVELS) {
      expect(resolveEffortKey(effort.key)).toBe(effort.key);
    }
  });

  it("falls back to the default for an unknown string", () => {
    expect(resolveEffortKey("turbo")).toBe(DEFAULT_EFFORT_KEY);
    expect(resolveEffortKey("")).toBe(DEFAULT_EFFORT_KEY);
  });

  it("falls back to the default for null/undefined (nothing persisted yet)", () => {
    expect(resolveEffortKey(null)).toBe(DEFAULT_EFFORT_KEY);
    expect(resolveEffortKey(undefined)).toBe(DEFAULT_EFFORT_KEY);
  });
});
