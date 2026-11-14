import { describe, expect, it } from "vitest";
import { resetCountLabel, resetLines } from "../src/resetTime.js";

const now = new Date("2026-11-14T10:00:00Z");
const r = (o: object) => ({ type: "full", label: "x", left: 1, expiresAt: "2026-12-10T22:00:00Z", usableNow: true, ...o });

describe("resetLines", () => {
  it("sorts soonest-expiring first and names types", () => {
    const l = resetLines([r({ type: "fable", expiresAt: "2027-03-09T07:59:00Z" }), r({})], now);
    expect(l.map((x) => x.title)).toEqual(["Full reset", "Fable reset"]);
  });
  it("drops expired and used-up ones", () => {
    expect(resetLines([r({ left: 0 }), r({ expiresAt: "2026-11-01T00:00:00Z" })], now)).toEqual([]);
  });
  it("counts", () => {
    expect(resetCountLabel([r({}), r({ left: 2 })], now)).toBe("3 resets");
    expect(resetCountLabel([], now)).toBeNull();
  });
});
