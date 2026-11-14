import { describe, expect, it } from "vitest";
import { resetAdvice } from "../src/resetTime.js";

const now = new Date("2026-11-14T10:00:00Z");
const reset = (expiresAt: string) => ({ type: "full", label: "x", left: 1, expiresAt, usableNow: true });
const usage = (pct: number, weeklyAt: string | null, expiresAt = "2026-12-10T22:00:00Z") => ({
  sevenDay: { pct, resetsAt: weeklyAt },
  limits: [{ kind: "weekly_all", pct, resetsAt: weeklyAt }],
  resets: [reset(expiresAt)],
});

describe("resetAdvice", () => {
  it("is null without resets", () => {
    expect(resetAdvice({ sevenDay: { pct: 99, resetsAt: null }, resets: [] }, now)).toBeNull();
  });
  it("warns when one is about to expire, whatever the usage", () => {
    expect(resetAdvice(usage(10, "2026-11-20T23:00:00Z", "2026-11-15T22:00:00Z"), now)?.kind).toBe("expiring");
  });
  it("says use now at the limit with days to go", () => {
    expect(resetAdvice(usage(97, "2026-11-20T23:00:00Z"), now)?.kind).toBe("use_now");
  });
  it("says wait at the limit right before the weekly refill", () => {
    expect(resetAdvice(usage(99, "2026-11-15T23:00:00Z"), now)?.kind).toBe("wait");
  });
  it("otherwise says later, with the deadline", () => {
    const a = resetAdvice(usage(21, "2026-11-20T23:00:00Z"), now);
    expect(a?.kind).toBe("later");
    expect(a?.text).toMatch(/Dec/);
  });
});
