import { describe, expect, it } from "vitest";
import { parseResets } from "../src/accounts/usage.js";

const grant = (o: object) => ({ id: "g", label: "L", resets_total: 1, resets_left: 1, ends_at: "2026-12-10T22:00:00+00:00", usable_now: true, paused: false, type: "full", clears: ["five_hour"], ...o });

describe("parseResets", () => {
  it("reads grants with resets left", () => {
    const r = parseResets({ cedar_ember: { grants: [grant({ id: "a" }), grant({ id: "b", gives_back_weekly: true })] } });
    expect(r.map((x) => [x.id, x.type, x.left, x.usableNow])).toEqual([["a", "full", 1, true], ["b", "fable", 1, true]]);
  });
  it("skips used-up or malformed grants and tolerates a missing block", () => {
    expect(parseResets({ cedar_ember: { grants: [grant({ resets_left: 0 }), null, { id: 3 }] } })).toEqual([]);
    expect(parseResets({})).toEqual([]);
    expect(parseResets({ cedar_ember: null })).toEqual([]);
  });
});
