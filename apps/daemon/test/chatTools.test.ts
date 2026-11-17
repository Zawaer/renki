import type { EventPayload, SearchResponse, Session, SessionEvent } from "@renki/protocol";
import { describe, expect, it } from "vitest";
import { chatPages, createChatTools, PAGE_CHARS, type ChatToolDeps } from "../src/claude/chatTools.js";

const T0 = Date.parse("2026-11-17T10:00:00Z");
const session = (id: string, title: string, over: Partial<Session> = {}): Session =>
  ({ id, repoId: null, repoName: "", baseBranch: null, branch: null, worktreePath: "/tmp", status: "idle", title, createdAt: T0, updatedAt: T0, lastActivityAt: T0, ...over }) as Session;

function events(id: string, turns: [string, string][]): SessionEvent[] {
  const p: EventPayload[] = [];
  turns.forEach(([q, a], i) => {
    p.push({ kind: "prompt_submitted", promptId: `p${i}`, deviceId: "d", text: q });
    p.push({ kind: "turn_started", turnId: `t${i}`, promptId: `p${i}`, trigger: "prompt" });
    p.push({ kind: "assistant_block", turnId: `t${i}`, blockIndex: 0, blockKind: "tool_use", text: null, toolUseId: `u${i}`, toolName: "Bash", toolInput: { command: "secret-tool-call" } });
    p.push({ kind: "assistant_block", turnId: `t${i}`, blockIndex: 1, blockKind: "text", text: a, toolUseId: null, toolName: null, toolInput: null });
    p.push({ kind: "turn_result", turnId: `t${i}`, promptId: `p${i}`, ok: true, costUsd: 0, durationMs: 1, errorMessage: null, inputTokens: 1, outputTokens: 1 });
  });
  return p.map((x, i) => ({ ...x, seq: i, sessionId: id, ts: T0 + i * 1000 }) as SessionEvent);
}

const sessions = [
  session("s_verda0001", "Local AI models vs. Verda"),
  session("s_other0001", "Mobile fixes", { lastActivityAt: T0 + 5 }),
  session("s_gone00001", "Verda old", { status: "deleted" }),
];
const log: Record<string, SessionEvent[]> = {
  s_verda0001: events("s_verda0001", [["Which GPU?", "The RTX PRO 6000, falling back to an A100."]]),
  s_other0001: events("s_other0001", [["Fix the popup", "Done. We could also run this on Verda later."]]),
};
const deps: ChatToolDeps = {
  currentId: "s_other0001",
  getSession: (id) => sessions.find((s) => s.id === id) ?? null,
  listSessions: () => sessions,
  readEvents: (id) => log[id] ?? [],
  search: (q): SearchResponse => ({
    query: q,
    truncated: false,
    hits: q.toLowerCase() === "verda" ? [{ sessionId: "s_other0001", sessionTitle: "Mobile fixes", repoName: "", repoId: null, seq: 3, ts: T0, role: "claude", promptId: null, turnId: "t0", blockIndex: 1, snippet: "…run this on Verda later.", matchStart: 12, matchLength: 5 }] : [],
  }),
  timeZone: () => "Europe/Helsinki",
};
const [readChat, searchChats] = createChatTools(deps);
const call = async (t: typeof readChat, args: unknown) => ((await t!.handler(args as never, {})) as { content: { text: string }[]; isError?: boolean });

describe("read_chat", () => {
  it("reads a chat by reference, without its tool calls", async () => {
    const r = await call(readChat, { chat: "[@Local AI models vs. Verda](renki://chat/s_verda0001)" });
    const t = r.content[0]!.text;
    expect(t).toContain("Local AI models vs. Verda (s_verda0001)");
    expect(t).toContain("The RTX PRO 6000, falling back to an A100.");
    expect(t).not.toContain("secret-tool-call");
    expect(t).toContain("Link: [@Local AI models vs. Verda](renki://chat/s_verda0001)");
  });

  it("refuses deleted or unknown chats", async () => {
    expect((await call(readChat, { chat: "s_gone00001" })).isError).toBe(true);
    expect((await call(readChat, { chat: "s_nope00001" })).isError).toBe(true);
  });

  it("pages a long chat from the newest end", () => {
    const long = events("s_verda0001", Array.from({ length: 40 }, (_, i) => [`Question ${i}`, `Answer ${i} ${"x".repeat(2000)}`] as [string, string]));
    const pages = chatPages(sessions[0]!, long, "UTC");
    expect(pages.length).toBeGreaterThan(2);
    expect(pages[0]).toContain("Answer 39");
    expect(pages.at(-1)).toContain("# Local AI models vs. Verda");
    for (const p of pages) expect(p.length).toBeLessThanOrEqual(PAGE_CHARS);
  });
});

describe("search_chats", () => {
  it("finds chats by title and by what was said, skipping deleted ones", async () => {
    const t = (await call(searchChats, { query: "verda" })).content[0]!.text;
    expect(t).toContain("s_verda0001");
    expect(t).toContain("s_other0001");
    expect(t).toContain("(this chat)");
    expect(t).toContain("run this on Verda later");
    expect(t).not.toContain("s_gone00001");
  });
});
