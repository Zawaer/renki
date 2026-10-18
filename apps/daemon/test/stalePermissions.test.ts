import { describe, expect, it } from "vitest";
import { PermissionBroker } from "../src/server/permissions.js";
import { SessionManager } from "../src/sessions/manager.js";
import { makeTestConfig, makeTestDb } from "./helpers.js";

describe("approvals that nothing is waiting on any more", () => {
  it("closes, at boot, every request a restart left open, in any session state", async () => {
    const manager = new SessionManager(makeTestConfig(), makeTestDb());
    const a = await manager.createSession({});
    const b = await manager.createSession({});
    // a: an open request, session already idle (a clean shutdown marks it so). b: one answered.
    manager.events.append(a.id, { kind: "permission_request", requestId: "r_open", turnId: "t", toolName: "mcp__mac__phone_shell", toolInput: {} });
    manager.events.append(b.id, { kind: "permission_request", requestId: "r_done", turnId: "t", toolName: "Bash", toolInput: {} });
    manager.events.append(b.id, { kind: "permission_resolved", requestId: "r_done", decision: "allow", byDeviceId: "d" });

    expect(manager.events.openPermissionRequests()).toEqual([{ sessionId: a.id, requestId: "r_open" }]);
    manager.closeStalePermissions();
    expect(manager.events.openPermissionRequests()).toEqual([]);
    expect(manager.events.read(a.id).at(-1)).toMatchObject({ kind: "permission_resolved", requestId: "r_open", decision: "deny", byDeviceId: null });
    // The answered one isn't touched again.
    expect(manager.events.read(b.id).filter((e) => e.kind === "permission_resolved")).toHaveLength(1);
  });

  it("settles a request at once when Claude cancels it, instead of at the timeout", async () => {
    const broker = new PermissionBroker(60 * 60_000);
    const ac = new AbortController();
    const decided = broker.resolverFor("s_1")({ requestId: "r1", turnId: "t", toolName: "Bash", toolInput: {}, signal: ac.signal });
    expect(broker.has("r1")).toBe(true);
    ac.abort();
    expect(await decided).toEqual({ decision: "deny", byDeviceId: null });
    expect(broker.has("r1")).toBe(false);
    // A late answer finds nothing (the client then just drops the card).
    expect(broker.answer("r1", "allow", "d")).toBe(false);
  });
});
