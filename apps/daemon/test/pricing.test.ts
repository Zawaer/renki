import { describe, expect, it } from "vitest";
import { priceFor, turnCostUsd, usageParts, withTokenCost } from "../src/stats/pricing.js";

describe("turn cost from tokens", () => {
  it("prices Opus 5.5 with no write split as 1-hour writes, plus cache reads and output", () => {
    // 10k written, 3.3M cache read, 2.8k out: the kind of turn that used to show as $1,200.
    const c = turnCostUsd({ inputTokens: 10_000, cachedInputTokens: 3_300_000, outputTokens: 2_800, model: "opus", resolvedModel: "claude-opus-5-5" })!;
    expect(c).toBeCloseTo(10_000 * 8e-6 + 3_300_000 * 0.2e-6 + 2_800 * 20e-6, 9);
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

  it("uses the published table, most specific model first", () => {
    expect(priceFor("claude-opus-5-5")).toMatchObject({ input: 4, output: 20, cacheRead: 0.2 });
    expect(priceFor("claude-opus-5")).toMatchObject({ input: 5, output: 25 });
    expect(priceFor("claude-opus-4-1")).toMatchObject({ input: 15, output: 75 });
    expect(priceFor("claude-sonnet-4-6")).toMatchObject({ input: 3, output: 15 });
    expect(priceFor("claude-fable-5-1")).toMatchObject({ input: 10, cacheRead: 0.25 });
    expect(priceFor("claude-fable-5")).toMatchObject({ cacheRead: 1 });
    expect(priceFor("claude-haiku-5-5")).toMatchObject({ input: 0.1, output: 0.5 });
  });

  it("prices fresh input, 5-minute and 1-hour cache writes apart when they were recorded", () => {
    const c = turnCostUsd({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0, model: "claude-opus-5-5", resolvedModel: null, cacheWrite5mTokens: 200_000, cacheWrite1hTokens: 300_000 })!;
    expect(c).toBeCloseTo(0.5 * 4 + 0.2 * 5 + 0.3 * 8, 9);
  });

  it("adds subagents, each at its own model's price, and splits a turn by model", () => {
    const t = {
      inputTokens: 0, cachedInputTokens: 0, outputTokens: 1_000_000, model: "opus", resolvedModel: null,
      subagentUsage: [{ model: "claude-haiku-5-5", inputTokens: 0, cachedInputTokens: 0, outputTokens: 1_000_000, cacheWrite5mTokens: null, cacheWrite1hTokens: null }],
    };
    expect(turnCostUsd(t)).toBeCloseTo(20.5, 9);
    expect(usageParts(t).map((u) => u.model)).toEqual(["opus", "claude-haiku-5-5"]);
  });
});
