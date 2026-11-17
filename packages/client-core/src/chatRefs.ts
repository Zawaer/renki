/**
 * References to other Renki chats inside a message: `[@Title](renki://chat/<id>)`.
 *
 * A plain Markdown link, so it reads fine anywhere (an older phone build shows
 * the text, Claude sees the id and can open the chat with its read_chat tool),
 * and clients that know the scheme draw it as a chip that opens the chat.
 * Claude can link a chat in its own replies the same way.
 */

const SCHEME = "renki://chat/";
/** Session ids are `s_` plus url-safe characters. */
const ID = /^s_[A-Za-z0-9_-]{4,64}$/;

/** The Markdown for a reference to chat `id` called `title`. Brackets in the title are dropped so the link stays one link. */
export function chatRefMarkdown(id: string, title: string): string {
  const label = (title.trim() || "Untitled chat").replace(/[[\]\n\r]/g, " ").replace(/\s+/g, " ").slice(0, 80);
  return `[@${label}](${SCHEME}${id})`;
}

/** The chat id a link points at, or null if it isn't a chat reference. */
export function parseChatLink(href: string | null | undefined): string | null {
  const h = (href ?? "").trim();
  if (!h.toLowerCase().startsWith(SCHEME)) return null;
  const id = decodeURIComponent(h.slice(SCHEME.length)).replace(/\/+$/, "");
  return ID.test(id) ? id : null;
}

export type ChatRefSegment = { type: "text"; text: string } | { type: "chat"; id: string; title: string };

const REF = /\[@([^\]\n]{0,120})\]\((renki:\/\/chat\/[^)\s]+)\)/g;

/** A message's text split into plain runs and chat references, in order. */
export function splitChatRefs(text: string): ChatRefSegment[] {
  const out: ChatRefSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(REF)) {
    const id = parseChatLink(m[2]);
    if (!id) continue;
    if (m.index! > last) out.push({ type: "text", text: text.slice(last, m.index) });
    out.push({ type: "chat", id, title: m[1]!.trim() || "Untitled chat" });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}

/**
 * The `@query` being typed at the caret, if any: an `@` at the start or after
 * whitespace, followed by non-space characters up to the caret. Returns the
 * query (without the `@`) and where the `@` sits, so a pick can replace it.
 */
export function chatMentionAt(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([^\s@[\]()]{0,40})$/.exec(before);
  if (!m) return null;
  return { query: m[2]!, start: before.length - m[2]!.length - 1 };
}

/** Chats matching a mention query, best first: title starts with it, then contains it; newest activity breaks ties. */
export function matchChats<T extends { id: string; title: string | null; lastActivityAt: number }>(chats: T[], query: string, limit = 8): T[] {
  const q = query.trim().toLowerCase();
  const scored = chats
    .map((c) => {
      const t = (c.title ?? "").toLowerCase();
      const score = !q ? 1 : t.startsWith(q) ? 3 : t.split(/\s+/).some((w) => w.startsWith(q)) ? 2 : t.includes(q) ? 1 : 0;
      return { c, score };
    })
    .filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score || b.c.lastActivityAt - a.c.lastActivityAt);
  return scored.slice(0, limit).map((x) => x.c);
}
