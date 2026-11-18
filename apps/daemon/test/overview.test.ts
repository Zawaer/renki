import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Session } from "@renki/protocol";
import { describe, expect, it } from "vitest";
import { createOverviewApprovalHook, describeChats, SEND_TO_CHAT_TOOL, START_CHAT_TOOL } from "../src/claude/overviewTools.js";
import { dayIn, NOTES_FILE, OverviewStore } from "../src/sessions/overview.js";
import { SessionManager } from "../src/sessions/manager.js";
import { makeTestConfig, makeTestDb } from "./helpers.js";

const NOW = Date.parse("2026-11-18T18:00:00Z");
const chat = (id: string, over: Partial<Session> = {}): Session =>
  ({ id, repoId: "r", repoName: "renki", baseBranch: "main", branch: "b", worktreePath: "/x", status: "idle", hasPendingPermission: false, controller: null, claudeSessionId: null, title: id, createdAt: NOW, updatedAt: NOW, lastActivityAt: NOW, ...over }) as Session;

describe("OverviewStore", () => {
  it("starts a fresh conversation only when the day changes", () => {
    const file = join(mkdtempSync(join(tmpdir(), "ov-")), "overview.json");
    const store = new OverviewStore(file);
    store.setSession("s_overview1");
    expect(store.startsNewDay("2026-11-18")).toBe(false); // first prompt ever
    expect(store.startsNewDay("2026-11-18")).toBe(false);
    expect(store.startsNewDay("2026-11-19")).toBe(true);
    // Kept across restarts.
    const again = new OverviewStore(file);
    expect(again.sessionId).toBe("s_overview1");
    expect(again.startsNewDay("2026-11-19")).toBe(false);
  });

  it("reads the day in the user's zone", () => {
    expect(dayIn("Europe/Helsinki", Date.parse("2026-11-18T22:30:00Z"))).toBe("2026-11-19");
    expect(dayIn("UTC", Date.parse("2026-11-18T22:30:00Z"))).toBe("2026-11-18");
  });
});

describe("describeChats", () => {
  it("lists the other chats newest first, saying what needs the user", () => {
    const sessions = [
      chat("s_me000001"),
      chat("s_waiting1", { title: "Deploy fix", status: "busy", hasPendingPermission: true, lastActivityAt: NOW - 60_000 }),
      chat("s_old00001", { title: "Old work", lastActivityAt: NOW - 3 * 86_400_000, unpushed: { commits: 2, changedFiles: 0 } }),
      chat("s_arch0001", { status: "archived" }),
      chat("s_gone0001", { status: "deleted" }),
    ];
    const t = describeChats({ currentId: "s_me000001", listSessions: () => sessions, lastPrompt: (id) => (id === "s_waiting1" ? { text: "push it\nplease", ts: NOW } : null) }, { includeArchived: false, limit: 40 }, NOW);
    expect(t).toMatch(/^2 chats \(archived left out\): 1 working now, 1 waiting on the user\./);
    expect(t.indexOf("s_waiting1")).toBeLessThan(t.indexOf("s_old00001"));
    expect(t).toContain("[@Deploy fix](renki://chat/s_waiting1)");
    expect(t).toContain("WAITING ON YOU");
    expect(t).toContain('last asked: "push it please"');
    expect(t).toContain("has work not pushed to GitHub");
    expect(t).not.toContain("s_me000001");
    expect(t).not.toContain("s_gone0001");
    expect(t).not.toContain("s_arch0001");
  });
});

describe("overview approval hook", () => {
  const hook = createOverviewApprovalHook().hooks[0]!;
  const run = (tool_name: string, tool_input: unknown) =>
    hook({ hook_event_name: "PreToolUse", tool_name, tool_input, session_id: "s", transcript_path: "", cwd: "/" } as never, "t", { signal: new AbortController().signal });

  it("always asks before starting or messaging a chat", async () => {
    expect(await run(START_CHAT_TOOL, { repo: "renki", prompt: "Fix the bug" })).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: 'Start a new chat in renki: "Fix the bug"' } });
    expect(await run(SEND_TO_CHAT_TOOL, { chat: "s_x", message: "carry on" })).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
    expect(await run("mcp__renki__list_chats", {})).toEqual({ continue: true });
  });
});

describe("SessionManager.openOverview", () => {
  it("makes the overview chat once, with a notes file, and brings it back from the archive", async () => {
    const manager = new SessionManager(makeTestConfig(), makeTestDb());
    const first = await manager.openOverview();
    expect(first.title).toBe("Overview");
    expect(first.repoId).toBeNull();
    expect(existsSync(resolve(first.worktreePath, NOTES_FILE))).toBe(true);
    expect(readFileSync(resolve(first.worktreePath, NOTES_FILE), "utf8")).toContain("## To do");
    expect((await manager.openOverview()).id).toBe(first.id);
    expect(manager.isOverview(first.id)).toBe(true);
    await manager.archiveSession(first.id);
    const back = await manager.openOverview();
    expect(back.id).toBe(first.id);
    expect(back.status).not.toBe("archived");
  });
});
