import { describe, expect, it } from "vitest";
import { readActiveNumber } from "../src/accounts/cswap.js";

/**
 * cswap's switch response is shaped differently from its list response, which
 * is what made every successful switch report `null` as the new active
 * account — visible as a missing "(now #3)" in the rate-limit notice and as a
 * null `activeAccountNumber` over REST.
 */
describe("readActiveNumber", () => {
  it("reads `to.number` from a real cswap --switch-to response", () => {
    expect(
      readActiveNumber({
        schemaVersion: 1,
        switched: true,
        from: { number: 1, email: "a@example.com" },
        to: { number: 3, email: "b@example.com" },
        strategy: "direct",
        reason: null,
        warnings: [],
      }),
    ).toBe(3);
  });

  /** cswap answers this when you switch to the account you're already on — still the active one. */
  it("reads the account back out of an already-active response", () => {
    expect(
      readActiveNumber({
        switched: false,
        from: { number: 3, email: "b@example.com" },
        to: { number: 3, email: "b@example.com" },
        reason: "already-active",
      }),
    ).toBe(3);
  });

  it("still accepts the list-shaped fields, in case the two responses ever converge", () => {
    expect(readActiveNumber({ activeAccountNumber: 2 })).toBe(2);
    expect(readActiveNumber({ active: { number: 5 } })).toBe(5);
  });

  it("is null for a response with nothing usable in it", () => {
    for (const junk of [null, undefined, {}, { to: {} }, { to: { email: "no number" } }, { switched: true }]) {
      expect(readActiveNumber(junk), JSON.stringify(junk)).toBeNull();
    }
  });
});
