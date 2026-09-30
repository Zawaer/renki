import type { Session, SessionEvent } from "@renki/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceRegistry } from "../src/push/devices.js";
import { LONG_TURN_MS, NEEDS_INPUT_GRACE_MS, Notifier, composePush } from "../src/push/notifier.js";
import type { SessionManager } from "../src/sessions/manager.js";
import type { PushTokenStore } from "../src/push/tokens.js";
import { makeTestConfig } from "./helpers.js";

const session = { id: "s1", title: "Shopping backlog", repoName: "shopping-tool", controller: null } as unknown as Session;
let seq = 0;
const ev = (payload: Record<string, unknown>) => ({ seq: seq++, sessionId: "s1", ts: 0, ...payload }) as SessionEvent;
const request = (toolName: string, toolInput: unknown) => ev({ kind: "permission_request", requestId: `r${seq}`, turnId: "t", toolName, toolInput });
const result = (extra: Record<string, unknown>) =>
  ev({ kind: "turn_result", turnId: "t", promptId: "p", ok: true, costUsd: 0, durationMs: 1, errorMessage: null, inputTokens: 1, outputTokens: 1, ...extra });

describe("composePush", () => {
  it("quotes the question Claude is asking", () => {
    const m = composePush(request("AskUserQuestion", { questions: [{ question: "Which size?", header: "Size", options: [{ label: "M", description: "" }], multiSelect: false }] }), session);
    expect(m).toMatchObject({ title: "Question · Shopping backlog", body: "Which size?", channel: "input", needsInput: true });
  });

  it("says which command wants approval", () => {
    expect(composePush(request("Bash", { command: "rm -rf build", description: "Clean the build" }), session)).toMatchObject({
      title: "Approve a command? · Shopping backlog",
      body: "Clean the build",
    });
    expect(composePush(request("Bash", { command: "rm -rf build" }), session)?.body).toBe("rm -rf build");
  });

  it("names the plan and edit approvals", () => {
    expect(composePush(request("ExitPlanMode", { plan: "x" }), session)?.title).toBe("Plan ready · Shopping backlog");
    expect(composePush(request("Edit", { file_path: "/w/src/app.ts" }), session)?.title).toBe("Approve an edit? · Shopping backlog");
  });

  it("only mentions long turns finishing, with the start of the reply", () => {
    expect(composePush(result({ durationMs: 5_000 }), session)).toBeNull();
    expect(composePush(result({ durationMs: LONG_TURN_MS }), session, "Found three good options.")).toMatchObject({
      title: "Done · Shopping backlog",
      body: "Found three good options.",
      channel: "updates",
    });
  });

  it("leaves a rate-limited failure to the pause notice that follows it", () => {
    expect(composePush(result({ ok: false, errorMessage: "You've hit your limit · resets 3pm" }), session)).toBeNull();
    expect(composePush(ev({ kind: "notice", text: "Paused on a usage limit. Waiting for the 5-hour limit to reset. The turn will continue automatically then.", level: "warn" }), session)).toMatchObject({
      title: "Paused on a limit · Shopping backlog",
      body: "Waiting for the 5-hour limit to reset. The turn will continue automatically then.",
    });
    expect(composePush(result({ ok: false, errorMessage: "spawn ENOENT" }), session)?.title).toBe("Turn failed · Shopping backlog");
  });

  it("stays quiet for a stopped turn and ordinary notices", () => {
    expect(composePush(result({ ok: false, interrupted: true, durationMs: LONG_TURN_MS }), session)).toBeNull();
    expect(composePush(ev({ kind: "notice", text: "Switched account", level: "info" }), session)).toBeNull();
  });
});

describe("Notifier delivery", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function setup(controller: string | null) {
    let listener: (e: SessionEvent) => void = () => {};
    const manager = {
      events: { onAny: (fn: (e: SessionEvent) => void) => ((listener = fn), () => {}), read: () => [] },
      getSession: () => ({ ...session, controller }),
    } as unknown as SessionManager;
    const devices = new DeviceRegistry();
    const removed: string[] = [];
    const tokens = {
      all: () => [
        { deviceId: "phone_1", expoToken: "ExponentPushToken[a]", platform: "android" },
        { deviceId: "web_1", expoToken: "ExponentPushToken[b]", platform: null },
      ],
      get: () => null,
      set: (id: string) => removed.push(id),
    } as unknown as PushTokenStore;
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const sent = JSON.parse(init.body) as unknown[];
      return new Response(JSON.stringify({ data: sent.map(() => ({ status: "ok" })) }));
    });
    vi.stubGlobal("fetch", fetchMock);
    new Notifier(makeTestConfig(), manager, devices, tokens).attach();
    return { emit: (e: SessionEvent) => listener(e), devices, fetchMock, removed };
  }

  const sentTo = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.flatMap((c) => (JSON.parse((c[1] as { body: string }).body) as { to: string }[]).map((m) => m.to));

  it("reaches every device that isn't connected, not just the controller", async () => {
    const { emit, devices, fetchMock } = setup(null);
    devices.connect("web_1");
    emit(request("Bash", { command: "ls" }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sentTo(fetchMock)).toEqual(["ExponentPushToken[a]"]);
  });

  /** You're at the laptop: answer there, and the phone never buzzes. */
  it("holds a request while someone's driving, and drops it once answered", async () => {
    vi.useFakeTimers();
    const { emit, devices, fetchMock } = setup("web_1");
    devices.connect("web_1");
    const req = request("Bash", { command: "ls" });
    emit(req);
    emit(ev({ kind: "permission_resolved", requestId: (req as { requestId: string }).requestId, decision: "allow", byDeviceId: "web_1" }));
    await vi.advanceTimersByTimeAsync(NEEDS_INPUT_GRACE_MS + 1);
    expect(fetchMock).not.toHaveBeenCalled();

    emit(request("Bash", { command: "pwd" }));
    await vi.advanceTimersByTimeAsync(NEEDS_INPUT_GRACE_MS + 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("forgets a device the push service says is gone", async () => {
    const { emit, fetchMock, removed } = setup(null);
    fetchMock.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ data: [{ status: "error", details: { error: "DeviceNotRegistered" } }, { status: "ok" }] })),
    );
    emit(request("Bash", { command: "ls" }));
    await vi.waitFor(() => expect(removed).toEqual(["phone_1"]));
  });
});
