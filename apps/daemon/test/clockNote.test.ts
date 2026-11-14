import { describe, expect, it } from "vitest";
import { CLOCK_NOTE_EVERY_MS, clockNote } from "../src/sessions/timeZoneNote.js";

describe("clockNote", () => {
  const at = new Date("2026-11-14T01:10:00Z"); // 03:10 in Helsinki

  it("gives the time in the user's zone, so a chat doesn't guess it", () => {
    const r = clockNote("Europe/Helsinki", undefined, at);
    expect(r.note).toBe("<renki-context>The time now is Sat 14 Nov, 03:10 in the user's zone (Europe/Helsinki).</renki-context>\n\n");
    expect(r.toldAt).toBe(at.getTime());
  });

  it("says nothing without a zone, or for a zone it doesn't know", () => {
    expect(clockNote(undefined, undefined, at).note).toBeNull();
    expect(clockNote("Not/AZone", undefined, at).note).toBeNull();
  });

  it("not again until a few minutes have passed", () => {
    const first = clockNote("Europe/Helsinki", undefined, at);
    const soon = clockNote("Europe/Helsinki", first.toldAt, new Date(at.getTime() + CLOCK_NOTE_EVERY_MS - 1));
    expect(soon.note).toBeNull();
    expect(soon.toldAt).toBe(first.toldAt);
    expect(clockNote("Europe/Helsinki", first.toldAt, new Date(at.getTime() + CLOCK_NOTE_EVERY_MS)).note).toContain("03:15");
  });
});
