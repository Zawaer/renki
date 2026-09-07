import { describe, expect, it } from "vitest";
import { formatResetTime, usageSeverity } from "../src/resetTime.js";

// Fixed "now": Monday 2026-09-07, 10:00 local.
const NOW = new Date(2026, 8, 7, 10, 0, 0);
const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m, d, h, min).toISOString();

describe("formatResetTime", () => {
  it("says today for a window resetting later the same day", () => {
    expect(formatResetTime(at(2026, 8, 7, 15, 30), NOW)).toBe("Resets today 15:30");
  });

  it("says tomorrow for the next day", () => {
    expect(formatResetTime(at(2026, 8, 8, 18, 0), NOW)).toBe("Resets tomorrow 18:00");
  });

  it("names the weekday inside the coming week", () => {
    expect(formatResetTime(at(2026, 8, 11, 15, 0), NOW)).toMatch(/^Resets \w{3} 15:00$/);
  });

  it("gives a date beyond a week out", () => {
    expect(formatResetTime(at(2026, 8, 20, 9, 0), NOW)).toMatch(/^Resets \w{3} \d{1,2} 09:00$/);
  });

  it("collapses an already-passed reset rather than showing a negative", () => {
    expect(formatResetTime(at(2026, 8, 6, 9, 0), NOW)).toBe("Reset");
  });

  it("returns null for missing or unparseable input", () => {
    expect(formatResetTime(null)).toBeNull();
    expect(formatResetTime(undefined)).toBeNull();
    expect(formatResetTime("not a date")).toBeNull();
  });
});

describe("usageSeverity", () => {
  it("trusts the API's own severity", () => {
    expect(usageSeverity("critical", 5)).toBe("critical");
    expect(usageSeverity("warning", 5)).toBe("warning");
    expect(usageSeverity("normal", 99)).toBe("normal");
  });

  it("falls back to the percentage when severity is missing or unknown", () => {
    expect(usageSeverity(undefined, 95)).toBe("critical");
    expect(usageSeverity("weird", 75)).toBe("warning");
    expect(usageSeverity(undefined, 10)).toBe("normal");
  });
});
