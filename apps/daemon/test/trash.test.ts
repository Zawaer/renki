import type { Session } from "@crc/protocol";
import { describe, expect, it } from "vitest";
import { dueForPurge, purgeAtFor } from "../src/sessions/trash.js";

const DAY = 24 * 60 * 60_000;
const RETENTION = 30 * DAY;
const NOW = 1_800_000_000_000;

function trashed(id: string, trashedAt: number | null): Pick<Session, "id" | "status" | "trashedAt"> {
  return { id, status: "trashed", trashedAt };
}

describe("purgeAtFor", () => {
  it("is the deadline retention days after the delete", () => {
    expect(purgeAtFor(NOW, RETENTION)).toBe(NOW + RETENTION);
  });

  it("has no deadline for a session that isn't in the trash", () => {
    expect(purgeAtFor(null, RETENTION)).toBeNull();
  });

  it("has no deadline when the bin is switched off, since nothing ever sits in it", () => {
    expect(purgeAtFor(NOW, 0)).toBeNull();
  });
});

describe("dueForPurge", () => {
  it("purges only what has actually run out of time", () => {
    const list = [trashed("old", NOW - RETENTION - DAY), trashed("fresh", NOW - DAY)];
    expect(dueForPurge(list, NOW, RETENTION)).toEqual(["old"]);
  });

  it("purges on the deadline itself, not a day later", () => {
    expect(dueForPurge([trashed("due", NOW - RETENTION)], NOW, RETENTION)).toEqual(["due"]);
  });

  it("ignores sessions that aren't in the trash, however old", () => {
    const list = [
      { id: "a", status: "archived" as Session["status"], trashedAt: null },
      { id: "b", status: "idle" as Session["status"], trashedAt: NOW - 10 * RETENTION },
    ];
    expect(dueForPurge(list, NOW, RETENTION)).toEqual([]);
  });

  /**
   * An unknown deadline has to mean "wait". Treating a missing trashedAt as
   * epoch zero would make it infinitely old and destroy it on the next sweep —
   * the one direction of this function that can't be undone.
   */
  it("leaves a trashed session with no recorded date alone rather than purging it", () => {
    expect(dueForPurge([trashed("mystery", null)], NOW, RETENTION)).toEqual([]);
  });

  it("purges nothing at all when the bin is disabled — a delete already purged directly", () => {
    expect(dueForPurge([trashed("old", 0)], NOW, 0)).toEqual([]);
  });

  it("takes the oldest first, so an interrupted sweep still makes progress on the most overdue", () => {
    const list = [trashed("newer", NOW - RETENTION - DAY), trashed("oldest", NOW - RETENTION - 9 * DAY)];
    expect(dueForPurge(list, NOW, RETENTION)).toEqual(["oldest", "newer"]);
  });
});
