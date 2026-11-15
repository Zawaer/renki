import { describe, expect, it } from "vitest";
import { priceFor, turnCostUsd, withTokenCost } from "../src/stats/pricing.js";

describe("turn cost from tokens", () => {
  it("prices Opus 5.5: writes at 1.25× input, cache reads, output", () => {
    // 10k written, 3.3M cache read, 2.8k out: the kind of turn that used to show as $1,200.
    const c = turnCostUsd({ inputTokens: 10_000, cachedInputTokens: 3_300_000, outputTokens: 2_800, model: "opus", resolvedModel: "claude-opus-5-5" })!;
    expect(c).toBeCloseTo(0.05 + 0.66 + 0.056, 3);
  });

  it("maps aliases and unknowns to the current models", () => {
    expect(priceFor("sonnet")).toEqual(priceFor("claude-sonnet-5-5"));
    expect(priceFor(null)).toEqual(priceFor("claude-opus-5-5"));
    expect(priceFor("default")).toEqual(priceFor("claude-opus-5-5"));
    expect(priceFor("claude-opus-5-5[1m]")).toEqual(priceFor("claude-opus-5-5"));
  });

  it("replaces a stored cost, but keeps it for a turn with no tokens", () => {
    const base = { kind: "turn_result", costUsd: 1200, model: "opus", resolvedModel: null };
    expect(withTokenCost({ ...base, inputTokens: 0, cachedInputTokens: 0, outputTokens: 1_000_000 }).costUsd).toBe(20);
    expect(withTokenCost({ ...base, inputTokens: null, cachedInputTokens: null, outputTokens: null }).costUsd).toBe(1200);
  });
});
