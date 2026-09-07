import type { Session } from "@crc/protocol";
import { describe, expect, it } from "vitest";
import { shouldReleaseIdleControl } from "../src/sessions/idleControl.js";

const IDLE = 15 * 60_000;
const NOW = 1_000_000_000;
const online = () => true;
const offline = () => false;

function session(over: Partial<Pick<Session, "controller" | "status" | "lastActivityAt">> = {}) {
  return { controller: "web_1", status: "idle" as Session["status"], lastActivityAt: NOW, ...over };
}

describe("shouldReleaseIdleControl", () => {
  it("never takes the lock from a controller that is still connected, however long they've been quiet", () => {
    const reading = session({ lastActivityAt: NOW - 6 * 60 * 60_000 });
    expect(shouldReleaseIdleControl(reading, online, NOW, IDLE)).toBe(false);
  });

  it("releases once the controller has gone away and the session has been quiet past the timeout", () => {
    expect(shouldReleaseIdleControl(session({ lastActivityAt: NOW - IDLE - 1 }), offline, NOW, IDLE)).toBe(true);
  });

  it("waits out the timeout after a disconnect rather than releasing immediately", () => {
    expect(shouldReleaseIdleControl(session({ lastActivityAt: NOW - 60_000 }), offline, NOW, IDLE)).toBe(false);
  });

  it("leaves a running turn alone even if nobody is watching it", () => {
    const busy = session({ status: "busy", lastActivityAt: NOW - 10 * IDLE });
    expect(shouldReleaseIdleControl(busy, offline, NOW, IDLE)).toBe(false);
  });

  it("has nothing to do when no device holds the lock", () => {
    expect(shouldReleaseIdleControl(session({ controller: null }), offline, NOW, IDLE)).toBe(false);
  });
});
