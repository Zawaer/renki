import { describe, expect, it } from "vitest";
import type { Session } from "@renki/protocol";
import { activeSessions, formatPurgeCountdown, trashedSessions } from "../src/trash.js";

const DAY = 24 * 60 * 60_000;
const NOW = 1_800_000_000_000;

describe("formatPurgeCountdown", () => {
  it("counts whole days, so a deadline reads the way retention is set", () => {
    expect(formatPurgeCountdown(NOW + 30 * DAY, NOW)).toBe("Deletes in 30 days");
    expect(formatPurgeCountdown(NOW + 2 * DAY, NOW)).toBe("Deletes in 2 days");
  });

  /** Rounding up, so a session deleted a second ago shows the full retention rather than one day less. */
  it("rounds up to the day, never down", () => {
    expect(formatPurgeCountdown(NOW + 30 * DAY - 1_000, NOW)).toBe("Deletes in 30 days");
    expect(formatPurgeCountdown(NOW + 6.2 * DAY, NOW)).toBe("Deletes in 7 days");
  });

  it("stops counting days inside the last one, rather than claiming to know local midnight", () => {
    expect(formatPurgeCountdown(NOW + 3 * 60 * 60_000, NOW)).toBe("Deletes within a day");
    expect(formatPurgeCountdown(NOW + 23 * 60 * 60_000, NOW)).toBe("Deletes within a day");
  });

  /** The sweep runs hourly, so an expired session is a normal thing to render. */
  it("reads as gone, not as time remaining, once the deadline has passed", () => {
    expect(formatPurgeCountdown(NOW - DAY, NOW)).toBe("Deleting soon");
  });

  it("says nothing for a session that isn't in the trash", () => {
    expect(formatPurgeCountdown(null, NOW)).toBeNull();
    expect(formatPurgeCountdown(undefined, NOW)).toBeNull();
  });
});

function session(over: Partial<Session>): Session {
  return {
    id: "s1",
    repoId: "r",
    repoName: "repo",
    baseBranch: "main",
    branch: "crc/x",
    worktreePath: "/tmp/x",
    status: "idle",
    hasPendingPermission: false,
    controller: null,
    claudeSessionId: null,
    title: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastActivityAt: NOW,
    ...over,
  };
}

describe("session partitioning", () => {
  it("keeps trashed sessions out of the main list, alongside archived ones", () => {
    const list = [
      session({ id: "live" }),
      session({ id: "gone", status: "trashed", trashedAt: NOW }),
      session({ id: "old", status: "archived" }),
    ];
    expect(activeSessions(list).map((s) => s.id)).toEqual(["live"]);
  });

  it("orders the bin by soonest deadline — the queue of what's about to be lost", () => {
    const list = [
      session({ id: "newer", status: "trashed", trashedAt: NOW - DAY }),
      session({ id: "live" }),
      session({ id: "oldest", status: "trashed", trashedAt: NOW - 20 * DAY }),
    ];
    expect(trashedSessions(list).map((s) => s.id)).toEqual(["oldest", "newer"]);
  });
});
