import { describe, expect, it } from "vitest";
import { timeZoneNote } from "../src/sessions/timeZoneNote.js";

// October: Helsinki is GMT+3, Stockholm and Paris GMT+2.
const now = new Date("2026-10-03T14:42:00Z");

describe("timeZoneNote", () => {
  it("tells Claude the user's zone when it differs from the host's", () => {
    const { note, told } = timeZoneNote("Europe/Stockholm", "Europe/Helsinki", undefined, now);
    expect(note).toContain("Europe/Stockholm (GMT+2)");
    expect(note).toContain("Europe/Helsinki (GMT+3)");
    expect(told).toBe("Europe/Stockholm");
  });

  it("says nothing again once Claude knows", () => {
    expect(timeZoneNote("Europe/Stockholm", "Europe/Helsinki", "Europe/Stockholm", now).note).toBeNull();
  });

  it("says nothing when the user is on the host's clock", () => {
    expect(timeZoneNote("Europe/Helsinki", "Europe/Helsinki", undefined, now).note).toBeNull();
    // Same offset, different name: same clock, nothing to say.
    expect(timeZoneNote("Europe/Paris", "Europe/Stockholm", undefined, now).note).toBeNull();
  });

  it("tells Claude when the user is back on the host's clock", () => {
    const { note, told } = timeZoneNote("Europe/Helsinki", "Europe/Helsinki", "Europe/Stockholm", now);
    expect(note).toContain("same time zone as this machine");
    expect(told).toBe("Europe/Helsinki");
  });

  it("ignores a missing or unknown zone", () => {
    expect(timeZoneNote(undefined, "Europe/Helsinki", "Europe/Stockholm", now)).toEqual({ note: null, told: "Europe/Stockholm" });
    expect(timeZoneNote("Mars/Olympus", "Europe/Helsinki", undefined, now).note).toBeNull();
  });
});
