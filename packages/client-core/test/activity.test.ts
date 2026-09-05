import type { StatsBucket } from "@crc/protocol";
import { describe, expect, it } from "vitest";
import { activityGrid, intensity, streaks, sumRecent, tokensInPerspective } from "../src/activity.js";

function day(key: string, turnCount: number, extra: Partial<StatsBucket> = {}): StatsBucket {
  return { key, costUsd: turnCount * 0.1, inputTokens: turnCount * 100, outputTokens: turnCount * 50, durationMs: turnCount * 1000, turnCount, okCount: turnCount, ...extra };
}

// A Friday, so the surrounding week is unambiguous (Mon 2026-08-31 … Sun 2026-09-06).
const NOW = new Date("2026-09-04T15:00:00Z");

describe("activityGrid", () => {
  it("ends on the week containing today, Monday-first, and marks days after today as future", () => {
    const grid = activityGrid(2, [day("2026-09-04", 3)], NOW);
    expect(grid).toHaveLength(2);
    expect(grid[1]!.map((c) => c.key)).toEqual([
      "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06",
    ]);
    expect(grid[1]![4]).toMatchObject({ turnCount: 3, future: false });
    expect(grid[1]![5]!.future).toBe(true);
    expect(grid[1]![6]!.future).toBe(true);
    expect(grid[0]![0]!.key).toBe("2026-08-24");
  });
});

describe("intensity", () => {
  it("maps a count onto 0..4 relative to the busiest day", () => {
    expect(intensity(0, 10)).toBe(0);
    expect(intensity(1, 10)).toBe(1);
    expect(intensity(5, 10)).toBe(2);
    expect(intensity(7, 10)).toBe(3);
    expect(intensity(10, 10)).toBe(4);
    expect(intensity(3, 0)).toBe(0);
  });
});

describe("streaks", () => {
  it("counts the current run back from today and finds the longest run anywhere", () => {
    const s = streaks(
      [day("2026-09-02", 1), day("2026-09-03", 2), day("2026-09-04", 1), day("2026-08-01", 1), day("2026-08-02", 1), day("2026-08-03", 1), day("2026-08-04", 1)],
      NOW,
    );
    expect(s).toEqual({ current: 3, longest: 4 });
  });

  it("does not break the current streak just because today has no turns yet", () => {
    expect(streaks([day("2026-09-02", 1), day("2026-09-03", 1)], NOW).current).toBe(2);
    expect(streaks([day("2026-09-01", 1)], NOW).current).toBe(0);
  });

  it("is zero on an empty history", () => {
    expect(streaks([], NOW)).toEqual({ current: 0, longest: 0 });
  });
});

describe("sumRecent", () => {
  it("adds only the trailing N days, today inclusive", () => {
    const total = sumRecent(7, [day("2026-09-04", 2), day("2026-08-29", 1), day("2026-08-28", 5)], NOW);
    expect(total.turnCount).toBe(3);
    expect(total.inputTokens).toBe(300);
  });
});

describe("tokensInPerspective", () => {
  it("scales the phrasing to the total", () => {
    expect(tokensInPerspective(0)).toBe("");
    expect(tokensInPerspective(75_000)).toBe("You've used about 10% of The Lord of the Rings in tokens.");
    expect(tokensInPerspective(740_000)).toBe("You've used about as many tokens as The Lord of the Rings.");
    expect(tokensInPerspective(44_300_000)).toBe("You've used ~59× more tokens than The Lord of the Rings.");
  });
});
