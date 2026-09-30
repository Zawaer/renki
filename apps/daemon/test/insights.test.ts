import type { EventPayload } from "@renki/protocol";
import { describe, expect, it } from "vitest";
import { compactions, events, presence, sessions } from "../src/db/schema.js";
import { commandKind, computeInsights, overlapMs, replacementLines, streaks } from "../src/stats/insights.js";
import { RESUME_CONTINUE_TEXT } from "../src/sessions/manager.js";
import { makeTestDb } from "./helpers.js";

const H = 3_600_000;
// Monday 2026-09-07, 10:00 UTC.
const MON = Date.UTC(2026, 8, 7, 10);

function setup() {
  const db = makeTestDb();
  const seqs = new Map<string, number>();
  const addSession = (id: string, repoName: string, createdAt = MON, worktreePath = `/w/${id}`) =>
    db.insert(sessions).values({ id, repoId: repoName, repoName, worktreePath, status: "idle", title: `Title ${id}`, createdAt, updatedAt: createdAt, lastActivityAt: createdAt }).run();
  const add = (sessionId: string, ts: number, payload: EventPayload) => {
    const seq = seqs.get(sessionId) ?? 0;
    seqs.set(sessionId, seq + 1);
    db.insert(events).values({ sessionId, seq, ts, kind: payload.kind, data: JSON.stringify(payload) }).run();
  };
  const turn = (sessionId: string, end: number, extra: Partial<Extract<EventPayload, { kind: "turn_result" }>> = {}) =>
    add(sessionId, end, { kind: "turn_result", turnId: `t${end}`, promptId: "p", ok: true, costUsd: 0.1, durationMs: 60_000, errorMessage: null, inputTokens: 100, outputTokens: 600, ...extra });
  const tool = (sessionId: string, ts: number, id: string, toolName: string, toolInput: unknown, turnId = "t") =>
    add(sessionId, ts, { kind: "assistant_block", turnId, blockIndex: 0, blockKind: "tool_use", text: null, toolUseId: id, toolName, toolInput });
  return { db, addSession, add, turn, tool };
}

describe("computeInsights", () => {
  it("buckets turns into the viewer's local weekday and hour", () => {
    const { db, addSession, turn } = setup();
    addSession("s1", "shop");
    turn("s1", MON + 60_000); // started 10:00 UTC = 13:00 in Helsinki (summer time)
    const utc = computeInsights(db, "UTC", MON + H);
    expect(utc.heatmap[0]![10]).toBe(1);
    const hel = computeInsights(db, "Europe/Helsinki", MON + H);
    expect(hel.heatmap[0]![13]).toBe(1);
    expect(computeInsights(db, "Not/AZone", MON).tz).toBe("UTC");
  });

  it("counts lines, files and commits from Claude's tool calls, skipping failed ones", () => {
    const { db, addSession, add, tool } = setup();
    addSession("s1", "shop");
    tool("s1", MON, "e1", "Edit", { file_path: "/w/s1/src/a.ts", old_string: "keep\nold", new_string: "keep\nnew\nmore" });
    tool("s1", MON + 1, "w1", "Write", { file_path: "/w/s1/src/b.ts", content: "1\n2\n3" });
    tool("s1", MON + 2, "e2", "Edit", { file_path: "/w/s1/src/a.ts", old_string: "x", new_string: "y" });
    add("s1", MON + 3, { kind: "tool_result", turnId: "t", toolUseId: "e2", ok: false, summary: "no match" });
    tool("s1", MON + 4, "b1", "Bash", { command: "cd /w/s1 && git add -A && git commit -m hi" });
    tool("s1", MON + 5, "b2", "Bash", { command: "rtk pnpm test" });

    const r = computeInsights(db, "UTC", MON + H);
    expect(r.linesDaily).toEqual([{ day: "2026-09-07", added: 5, removed: 1 }]);
    expect(r.topFiles[0]).toMatchObject({ repoName: "shop", path: "src/a.ts", edits: 1 });
    expect(r.records.mostFilesInSession?.value).toBe(2);
    expect(r.git.commits).toBe(1);
    expect(r.shellCommands.map((c) => c.key)).toEqual(expect.arrayContaining(["git commit", "pnpm test"]));
    expect(r.tools.find((t) => t.name === "Edit")).toEqual({ name: "Edit", count: 2, failed: 1 });
  });

  it("measures approvals by device and tool, leaving questions out", () => {
    const { db, addSession, add } = setup();
    addSession("s1", "shop");
    add("s1", MON, { kind: "permission_request", requestId: "r1", turnId: "t", toolName: "Bash", toolInput: {} });
    add("s1", MON + 4_000, { kind: "permission_resolved", requestId: "r1", decision: "allow", byDeviceId: "phone_1" });
    add("s1", MON, { kind: "permission_request", requestId: "r2", turnId: "t", toolName: "Bash", toolInput: {} });
    add("s1", MON + 10_000, { kind: "permission_resolved", requestId: "r2", decision: "deny", byDeviceId: "web_1" });
    add("s1", MON, { kind: "permission_request", requestId: "r3", turnId: "t", toolName: "AskUserQuestion", toolInput: {} });
    add("s1", MON + 1, { kind: "permission_resolved", requestId: "r3", decision: "allow", byDeviceId: "web_1" });

    const a = computeInsights(db, "UTC", MON + H).approvals;
    expect(a).toMatchObject({ count: 2, allowed: 1, denied: 1, medianResponseMs: 7_000 });
    expect(a.byDevice).toEqual(expect.arrayContaining([{ key: "phone", count: 1, medianResponseMs: 4_000 }]));
    expect(a.byTool).toEqual([{ tool: "Bash", allowed: 1, denied: 1 }]);
  });

  it("sorts outcomes, limit pauses and account switches", () => {
    const { db, addSession, add, turn } = setup();
    addSession("s1", "shop");
    turn("s1", MON, { ok: false, errorMessage: "You've hit your limit · resets 3pm" });
    add("s1", MON + 1, { kind: "notice", text: "Switched account (now #2) — retrying.", level: "info" });
    add("s1", MON + 2, { kind: "notice", text: "Paused on a usage limit. Waiting. The turn will continue automatically then.", level: "warn" });
    add("s1", MON + 2 + 2 * H, { kind: "notice", text: "Usage limit reset — continuing.", level: "info" });
    add("s1", MON + 2 + 2 * H, { kind: "prompt_submitted", promptId: "p2", deviceId: "web_1", text: RESUME_CONTINUE_TEXT });
    turn("s1", MON + 3 * H, { ok: false, interrupted: true, errorMessage: "stopped" });

    const r = computeInsights(db, "UTC", MON + 4 * H);
    expect(r.outcomes).toMatchObject({ limited: 1, stopped: 1, ok: 0 });
    expect(r.limits).toMatchObject({ hits: 1, pauses: 1, pausedMs: 2 * H, switches: 1, switchesTo: [{ key: "#2", count: 1 }] });
    // Renki's own continuation isn't one of your prompts.
    expect(r.prompts.count).toBe(0);
    expect(r.achievements.find((x) => x.id === "comeback")?.achieved).toBe(true);
  });

  it("counts turn time with nobody connected as hands-off", () => {
    const { db, addSession, turn } = setup();
    addSession("s1", "shop");
    db.insert(presence).values({ ts: MON - H, anyoneOnline: true }).run();
    db.insert(presence).values({ ts: MON - 30 * 60_000, anyoneOnline: false }).run();
    db.insert(presence).values({ ts: MON + 30 * 60_000, anyoneOnline: true }).run();
    turn("s1", MON + H, { durationMs: 2 * H }); // MON-1h .. MON+1h
    const h = computeInsights(db, "UTC", MON + 2 * H).handsOff;
    expect(h).toEqual({ since: MON - H, handsOffMs: H, turnMs: 2 * H });
  });

  it("finds records, the most turns at once, and a session to remember", () => {
    const { db, addSession, add, turn } = setup();
    const now = MON + 400 * 86_400_000;
    addSession("old", "shop", now - 366 * 86_400_000);
    add("old", now - 366 * 86_400_000, { kind: "prompt_submitted", promptId: "p", deviceId: "web_1", text: "build me a shop" });
    addSession("s2", "blog");
    turn("old", MON + 60_000, { costUsd: 2.5 });
    turn("s2", MON + 90_000, { durationMs: 120_000 });
    const r = computeInsights(db, "UTC", now);
    expect(r.records.mostExpensiveTurn).toMatchObject({ value: 2.5, session: { sessionId: "old" } });
    expect(r.records.mostAtOnce?.count).toBe(2);
    expect(r.longestTurn?.value).toBe(120_000);
    expect(r.rememberWhen).toMatchObject({ session: { sessionId: "old" }, ago: "a year ago", firstPrompt: "build me a shop" });
    expect(r.words.yours).toBe(4);
  });

  it("reports compactions", () => {
    const { db } = setup();
    db.insert(compactions).values({ sessionId: "s", ts: MON, trigger: "auto", preTokens: 150_000 }).run();
    db.insert(compactions).values({ sessionId: "s", ts: MON, trigger: "manual", preTokens: 50_000 }).run();
    expect(computeInsights(db, "UTC", MON).compactions).toEqual({ count: 2, auto: 1, avgPreTokens: 100_000 });
  });
});

describe("helpers", () => {
  it("counts only the lines an edit changes", () => {
    expect(replacementLines("a\nb\nc", "a\nB\nc")).toEqual({ added: 1, removed: 1 });
    expect(replacementLines("", "x\ny")).toEqual({ added: 2, removed: 0 });
  });

  it("names a command by what it runs", () => {
    expect(commandKind("cd x && pnpm --filter web test")).toBe("pnpm test");
    expect(commandKind("git -C /repo status")).toBe("git status");
    expect(commandKind("FOO=1 ./node_modules/.bin/vitest run")).toBe("vitest");
    expect(commandKind("ls -la | head")).toBe("ls");
  });

  it("finds the current and longest streak", () => {
    expect(streaks(["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-06", "2026-09-07"], "2026-09-08")).toEqual({ current: 2, longest: 3, activeDays: 5 });
    expect(streaks(["2026-09-01"], "2026-09-08").current).toBe(0);
  });

  it("adds up overlap against sorted stretches", () => {
    expect(overlapMs([{ start: 0, end: 10 }, { start: 5, end: 15 }], [{ start: 8, end: 12 }])).toBe(2 + 4);
  });
});
