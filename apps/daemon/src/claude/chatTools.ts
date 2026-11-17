import { tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { applyEvents, initialConversation, restoreBlockGaps } from "@renki/client-core";
import type { SearchResponse, Session, SessionEvent } from "@renki/protocol";
import { z } from "zod";
import { renderMarkdown } from "../export/markdown.js";

/**
 * read_chat and search_chats: Claude reading the user's other Renki chats.
 *
 * The user points at one with an `@` reference, `[@Title](renki://chat/<id>)`
 * (see client-core's chatRefs), or asks about one in words ("what did we
 * decide about Verda?"), which search_chats finds. Read-only: nothing here
 * writes to another chat. Only what was said is returned (tool calls,
 * thinking and media left out), newest part first, a page at a time, so a
 * long chat doesn't flood the context the way a pasted export did.
 */

export const READ_CHAT_TOOL = "mcp__renki__read_chat";
export const SEARCH_CHATS_TOOL = "mcp__renki__search_chats";

/** Characters per page of read_chat (~7.5k tokens). */
export const PAGE_CHARS = 30_000;

export type ChatToolDeps = {
  /** The chat calling the tools, so it can say "this is the chat you're in". */
  currentId: string;
  getSession: (id: string) => Session | null;
  listSessions: () => Session[];
  readEvents: (id: string) => SessionEvent[];
  search: (query: string, limit: number) => SearchResponse;
  timeZone: () => string;
};

const visible = (s: Session | null): s is Session => !!s && s.status !== "trashed" && s.status !== "deleted";
const title = (s: Session) => s.title?.trim() || "Untitled chat";

function when(ms: number, timeZone: string): string {
  return new Date(ms).toLocaleString("en-GB", { timeZone, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function describe(s: Session, tz: string): string {
  const where = s.repoId ? `repo ${s.repoName}${s.branch ? `, branch ${s.branch}` : ""}` : "no repo";
  return `${title(s)} (${s.id}) — ${where}, ${s.status}, last active ${when(s.lastActivityAt, tz)}`;
}

/** The chat as Markdown, split into pages from the newest end. */
export function chatPages(session: Session, events: SessionEvent[], timeZone: string): string[] {
  const conv = restoreBlockGaps(applyEvents(initialConversation(session.id), events));
  const md = renderMarkdown(
    conv,
    { title: title(session), repoName: session.repoId ? session.repoName : null, branch: session.branch, createdAt: session.createdAt, exportedAt: Date.now() },
    { media: false, tools: false, thinking: false, stats: false },
    timeZone,
    () => null,
  );
  const pages: string[] = [];
  let end = md.length;
  while (end > 0) {
    let start = Math.max(0, end - PAGE_CHARS);
    // Cut at a message boundary when there's one in the last third of the page.
    if (start > 0) {
      const cut = md.indexOf("\n---\n", start);
      if (cut !== -1 && cut < end - PAGE_CHARS / 3) start = cut + 1;
    }
    pages.push(md.slice(start, end));
    end = start;
  }
  return pages.length ? pages : [md];
}

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}

function idFrom(raw: string): string {
  const m = /s_[A-Za-z0-9_-]{4,64}/.exec(raw);
  return m ? m[0] : raw.trim();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createChatTools(deps: ChatToolDeps): SdkMcpToolDefinition<any>[] {
  return [
    tool(
      "read_chat",
      "Read another of the user's Renki chats: what was said in it (the user's messages and Claude's replies; tool calls and thinking left out). " +
        "`chat` is its id (`s_…`) or a reference like `[@Title](renki://chat/s_…)`, which is how the user points at a chat in a message. " +
        "Returns the newest part first; ask for `page` 2, 3, … for earlier parts, only if you need them. Read-only. " +
        "To link a chat in your reply, write `[@Title](renki://chat/<id>)`: the app shows it as a chip that opens the chat.",
      { chat: z.string().trim().min(1).max(300), page: z.number().int().min(1).max(500).optional() },
      async ({ chat, page }) => {
        const id = idFrom(chat);
        const s = deps.getSession(id);
        if (!visible(s)) return text(`No chat ${id}: it doesn't exist or is deleted. Use search_chats to find one.`, true);
        const tz = deps.timeZone();
        const pages = chatPages(s, deps.readEvents(id), tz);
        const n = Math.min(page ?? 1, pages.length);
        const head = [
          describe(s, tz),
          id === deps.currentId ? "This is the chat you are in now." : null,
          pages.length > 1 ? `Part ${n} of ${pages.length}, ${n === 1 ? "the newest" : "earlier"}.${n < pages.length ? ` For earlier messages, read page ${n + 1}.` : " This is the start of the chat."}` : null,
          `Link: [@${title(s)}](renki://chat/${id})`,
        ].filter(Boolean);
        return text(`${head.join("\n")}\n\n${pages[n - 1]}`);
      },
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      "search_chats",
      "Find the user's other Renki chats by title or by what was said in them, e.g. when they ask what was decided somewhere or name a chat without linking it. " +
        "Matches `query` literally (case-insensitive). Returns matching chats, newest first, with snippets; open one with read_chat. Read-only.",
      { query: z.string().trim().min(2).max(200), limit: z.number().int().min(1).max(20).optional() },
      async ({ query, limit }) => {
        const max = limit ?? 8;
        const tz = deps.timeZone();
        const q = query.toLowerCase();
        const byTitle = deps
          .listSessions()
          .filter((s) => visible(s) && title(s).toLowerCase().includes(q))
          .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
        const snippets = new Map<string, string[]>();
        const order: string[] = [];
        for (const h of deps.search(query, 200).hits) {
          if (!snippets.has(h.sessionId)) {
            snippets.set(h.sessionId, []);
            order.push(h.sessionId);
          }
          const list = snippets.get(h.sessionId)!;
          if (list.length < 3) list.push(`${h.role === "you" ? "User" : "Claude"}, ${when(h.ts, tz)}: ${h.snippet}`);
        }
        const ids = [...new Set([...byTitle.map((s) => s.id), ...order])];
        const found = ids
          .map((id) => deps.getSession(id))
          .filter(visible)
          .slice(0, max);
        if (!found.length) return text(`No chats mention "${query}".`);
        const lines = found.map((s) => {
          const hits = snippets.get(s.id) ?? [];
          return [`- ${describe(s, tz)}${s.id === deps.currentId ? " (this chat)" : ""}`, ...hits.map((h) => `    ${h}`)].join("\n");
        });
        return text(`${found.length} chat${found.length === 1 ? "" : "s"} for "${query}":\n${lines.join("\n")}`);
      },
      { annotations: { readOnlyHint: true } },
    ),
  ];
}
