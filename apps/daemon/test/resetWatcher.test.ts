import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ResetWatcher, resetPushFor } from "../src/accounts/resetWatcher.js";

const now = new Date("2026-11-14T10:00:00Z");
const acct = (pct: number, expiresAt = "2026-12-10T22:00:00Z"): any => ({
  email: "a@b.c",
  usage: { fiveHour: { pct: 0, resetsAt: null }, sevenDay: { pct, resetsAt: "2026-11-20T23:00:00Z" }, limits: [], extra: null, resets: [{ id: "x", label: "x", type: "full", left: 1, total: 1, expiresAt, usableNow: true, clears: [] }] },
});

describe("resetPushFor", () => {
  it("stays quiet when there's nothing to say", () => {
    expect(resetPushFor(acct(20), now)).toBeNull();
    expect(resetPushFor({ email: "a@b.c", usage: null }, now)).toBeNull();
  });
  it("speaks for an expiring reset and for use-now", () => {
    expect(resetPushFor(acct(20, "2026-11-15T20:00:00Z"), now)?.title).toMatch(/expire/);
    expect(resetPushFor(acct(97), now)?.title).toMatch(/Use a free/);
  });
});

describe("ResetWatcher", () => {
  it("pushes once per account per day, and remembers across restarts", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "rw-")), "n.json");
    const sent: string[] = [];
    const make = () => new ResetWatcher(file, async () => [acct(97)], async (t) => void sent.push(t));
    expect(await make().check(now)).toBe(1);
    expect(await make().check(now)).toBe(0);
    expect(await make().check(new Date("2026-11-15T10:00:00Z"))).toBe(1);
    expect(sent).toHaveLength(2);
  });
});
