import { describe, expect, it } from "vitest";
import {
  formatCost,
  formatDuration,
  formatSuccessRate,
  lastNDays,
  tickIndices,
} from "../src/statsFormat.js";

describe("formatSuccessRate", () => {
  it("shows an em dash when there are no turns yet", () => {
    expect(formatSuccessRate({ turnCount: 0, okCount: 0 })).toBe("—");
  });

  it("rounds to the nearest percent", () => {
    expect(formatSuccessRate({ turnCount: 3, okCount: 2 })).toBe("67%");
    expect(formatSuccessRate({ turnCount: 4, okCount: 4 })).toBe("100%");
    expect(formatSuccessRate({ turnCount: 10, okCount: 0 })).toBe("0%");
  });
});

describe("formatCost", () => {
  it("shows $0.00 for exactly zero", () => {
    expect(formatCost(0)).toBe("$0.00");
  });

  it("uses 4 decimal places under a dollar", () => {
    expect(formatCost(0.0268)).toBe("$0.0268");
    expect(formatCost(0.999)).toBe("$0.9990");
  });

  it("uses 2 decimal places at a dollar or over", () => {
    expect(formatCost(1)).toBe("$1.00");
    expect(formatCost(12.345)).toBe("$12.35");
  });
});

describe("formatDuration", () => {
  it("floors to 0s for zero/negative", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(-500)).toBe("0s");
  });

  it("shows seconds only under a minute", () => {
    expect(formatDuration(45_000)).toBe("45s");
  });

  it("shows minutes and seconds under an hour", () => {
    expect(formatDuration(125_000)).toBe("2m 5s");
  });

  it("shows hours and minutes under a day", () => {
    expect(formatDuration(2 * 3_600_000 + 15 * 60_000)).toBe("2h 15m");
  });

  it("shows days and hours at a day or over", () => {
    expect(formatDuration(2 * 86_400_000 + 3 * 3_600_000)).toBe("2d 3h");
  });
});

describe("lastNDays", () => {
  it("returns exactly n entries, oldest first, ending today", () => {
    const days = lastNDays(5, []);
    expect(days).toHaveLength(5);
    const todayKey = new Date().toISOString().slice(0, 10);
    expect(days[days.length - 1]!.key).toBe(todayKey);
  });

  it("zero-fills days with no recorded turns", () => {
    const days = lastNDays(3, []);
    for (const day of days) {
      expect(day).toMatchObject({ costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, turnCount: 0, okCount: 0 });
    }
  });

  it("preserves real bucket data for a matching day", () => {
    const todayKey = new Date().toISOString().slice(0, 10);
    const real = { key: todayKey, costUsd: 1.23, inputTokens: 10, outputTokens: 20, durationMs: 5000, turnCount: 2, okCount: 2 };
    const days = lastNDays(3, [real]);
    expect(days[days.length - 1]).toEqual(real);
  });
});

describe("tickIndices", () => {
  it("includes every index when count fits within maxTicks", () => {
    expect(tickIndices(4, 6)).toEqual(new Set([0, 1, 2, 3]));
  });

  it("always includes the first and last index when sparse", () => {
    const ticks = tickIndices(14, 6);
    expect(ticks.has(0)).toBe(true);
    expect(ticks.has(13)).toBe(true);
    expect(ticks.size).toBeLessThanOrEqual(6);
  });

  it("respects a smaller maxTicks (mobile's narrower default)", () => {
    const ticks = tickIndices(14, 5);
    expect(ticks.size).toBeLessThanOrEqual(5);
  });
});
