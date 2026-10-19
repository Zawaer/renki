import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventPayload } from "@renki/protocol";
import type { MacProgress, MacResult } from "../src/mac/bridge.js";
import { MacBuilds } from "../src/mac/builds.js";
import { MacCallIds } from "../src/mac/tools.js";

function setup() {
  const events: Array<{ sessionId: string; payload: EventPayload }> = [];
  const finished: Array<{ sessionId: string; message: string }> = [];
  const builds = new MacBuilds();
  builds.setSink({
    emit: (sessionId, payload) => events.push({ sessionId, payload }),
    finished: (sessionId, message) => finished.push({ sessionId, message }),
  });
  let progress: (p: MacProgress) => void = () => {};
  let settle: (r: MacResult) => void = () => {};
  const start = () =>
    builds.start({
      sessionId: "s1",
      toolUseId: "tu1",
      job: "android-debug",
      run: (onProgress) => {
        progress = onProgress;
        return new Promise<MacResult>((r) => (settle = r));
      },
    });
  return { builds, events, finished, start, progress: (p: MacProgress) => progress(p), settle: (r: MacResult) => settle(r) };
}

const kinds = (events: Array<{ payload: EventPayload }>) =>
  events.map((e) => (e.payload.kind === "mac_build" ? `${e.payload.state}:${e.payload.phase}:${e.payload.detail ?? ""}` : e.payload.kind));

afterEach(() => vi.useRealTimers());

describe("MacBuilds", () => {
  it("reports a build from start to end, and tells Claude how it went", async () => {
    const t = setup();
    const b = t.start();
    expect(t.builds.running("s1").map((x) => x.id)).toEqual([b.id]);
    expect(t.events[0]!.payload).toMatchObject({ kind: "mac_build", buildId: b.id, toolUseId: "tu1", job: "android-debug", state: "running", endedAt: null });

    t.progress({ phase: "Syncing files", detail: "3 changed of 900" });
    t.progress({ phase: "Building" });
    t.settle({ ok: true, text: "Job android-debug on Mac: succeeded in 400s.\nArtifact app.apk: /data/x/app.apk" });
    await new Promise((r) => setTimeout(r, 0));

    expect(kinds(t.events)).toEqual([
      "running:Starting:",
      "running:Syncing files:3 changed of 900",
      "running:Building:",
      "succeeded:Succeeded:Job android-debug on Mac: succeeded in 400s.",
    ]);
    expect(t.builds.running("s1")).toEqual([]);
    expect(t.finished).toHaveLength(1);
    expect(t.finished[0]!.message).toContain(`<mac-build-finished build="${b.id}" job="android-debug" outcome="succeeded">`);
    expect(t.finished[0]!.message).toContain("Artifact app.apk");
    expect(t.builds.forSession("s1")[0]!.result?.ok).toBe(true);
  });

  it("logs a new log line at most every ten seconds, but every phase change", () => {
    vi.useFakeTimers();
    const t = setup();
    t.start();
    t.progress({ phase: "Building", detail: "a" });
    t.progress({ phase: "Building", detail: "b" });
    vi.advanceTimersByTime(5_000);
    t.progress({ phase: "Building", detail: "c" });
    vi.advanceTimersByTime(5_000);
    t.progress({ phase: "Building", detail: "d" });
    t.progress({ phase: "Uploading artifacts" });
    expect(kinds(t.events)).toEqual(["running:Starting:", "running:Building:a", "running:Building:d", "running:Uploading artifacts:"]);
  });

  it("reports a failure as failed, and keeps builds per session", async () => {
    const t = setup();
    t.start();
    t.settle({ ok: false, text: "The Mac disconnected before it answered." });
    await new Promise((r) => setTimeout(r, 0));
    expect(t.events.at(-1)!.payload).toMatchObject({ state: "failed", detail: "The Mac disconnected before it answered." });
    expect(t.finished[0]!.message).toContain('outcome="failed"');
    expect(t.builds.forSession("other")).toEqual([]);
  });
});

describe("MacCallIds", () => {
  it("gives a handler the newest call for its job, dropping older ones that never ran", () => {
    const ids = new MacCallIds();
    ids.note("denied", { job: "android-debug", install: true });
    ids.note("t2", { job: "android-debug" });
    ids.note("t3", { job: "android-release" });
    expect(ids.take("android-debug")).toBe("t2");
    expect(ids.take("android-debug")).toBeNull();
    expect(ids.take("android-release")).toBe("t3");
  });
});
