import { describe, expect, it } from "vitest";
import { reportIsStale, toAccountUsage } from "../src/accounts/service.js";

const T = Date.parse("2026-11-14T12:36:00Z");
const usage = (kind: string, pct: number, resetsAt: string | null): any => ({
  fiveHour: { pct: 0, resetsAt: null },
  sevenDay: { pct: 0, resetsAt: null },
  limits: [{ kind, label: kind, model: null, pct, resetsAt, severity: "normal", isActive: true }],
  resets: [],
  extra: null,
});
const view = (u: any, o: object = {}): any => ({ blockedBy: "the 5-hour limit", blockedUntil: T, ...o, usage: u });

describe("reportIsStale", () => {
  const now = Date.parse("2026-11-14T12:25:00Z");
  it("keeps a block while the window is still full and ends when reported", () => {
    expect(reportIsStale(usage("session", 100, "2026-11-14T12:36:00Z"), view(null), now)).toBe(false);
    expect(reportIsStale(usage("session", 99.5, "2026-11-14T12:37:00Z"), view(null), now)).toBe(false);
    // Not caught up with the rejection yet: same window, low reading.
    expect(reportIsStale(usage("session", 30, "2026-11-14T12:36:00Z"), view(null), now)).toBe(false);
  });
  it("drops it once a reset refilled the window (low use, different or no reset time)", () => {
    expect(reportIsStale(usage("session", 3, null), view(null), now)).toBe(true);
    expect(reportIsStale(usage("session", 96, "2026-11-14T17:10:00Z"), view(null), now)).toBe(true);
  });
  it("checks the weekly window for a weekly block", () => {
    expect(reportIsStale(usage("weekly_all", 30, "2026-11-20T23:00:00Z"), view(null, { blockedBy: "the weekly limit" }), now)).toBe(true);
  });
  it("toAccountUsage then no longer forces 100%", () => {
    const out = toAccountUsage(view(usage("session", 3, null)), now)!;
    expect(out.limits.some((l) => l.kind === "reported")).toBe(false);
  });
  it("and still forces it while the report holds", () => {
    const out = toAccountUsage(view(usage("session", 100, "2026-11-14T12:36:00Z")), now)!;
    expect(out.limits.every((l) => l.pct >= 100)).toBe(true);
  });
});
