import { describe, expect, it } from "vitest";
import { chatMentionAt, chatRefMarkdown, matchChats, parseChatLink, splitChatRefs } from "../src/chatRefs.js";

describe("chat references", () => {
  it("round-trips a reference through Markdown, keeping it one link", () => {
    const md = chatRefMarkdown("s_iJiOL29ADS", "Fix [the] bug\nnow");
    expect(md).toBe("[@Fix  the  bug now](renki://chat/s_iJiOL29ADS)".replace(/  /g, " "));
    expect(splitChatRefs(`see ${md} please`)).toEqual([
      { type: "text", text: "see " },
      { type: "chat", id: "s_iJiOL29ADS", title: "Fix the bug now" },
      { type: "text", text: " please" },
    ]);
  });

  it("only treats renki chat links with a real id as references", () => {
    expect(parseChatLink("renki://chat/s_abcDEF123")).toBe("s_abcDEF123");
    expect(parseChatLink("https://example.com")).toBeNull();
    expect(parseChatLink("renki://chat/../etc")).toBeNull();
    expect(splitChatRefs("[@x](renki://chat/nope)")).toEqual([{ type: "text", text: "[@x](renki://chat/nope)" }]);
  });

  it("finds the @query being typed, not an email address", () => {
    expect(chatMentionAt("ask @ver", 8)).toEqual({ query: "ver", start: 4 });
    expect(chatMentionAt("@", 1)).toEqual({ query: "", start: 0 });
    expect(chatMentionAt("mail me@host", 12)).toBeNull();
    expect(chatMentionAt("ask @ver more", 13)).toBeNull();
  });

  it("ranks title prefix, then word prefix, then substring, newest first", () => {
    const chats = [
      { id: "s_aaaa1", title: "Local AI models vs Verda", lastActivityAt: 1 },
      { id: "s_aaaa2", title: "Verda GPU plan", lastActivityAt: 2 },
      { id: "s_aaaa3", title: "Overdamped", lastActivityAt: 3 },
      { id: "s_aaaa4", title: null, lastActivityAt: 4 },
    ];
    expect(matchChats(chats, "verd").map((c) => c.id)).toEqual(["s_aaaa2", "s_aaaa1", "s_aaaa3"]);
    expect(matchChats(chats, "erd").map((c) => c.id)).toEqual(["s_aaaa3", "s_aaaa2", "s_aaaa1"]);
    expect(matchChats(chats, "").map((c) => c.id)).toEqual(["s_aaaa4", "s_aaaa3", "s_aaaa2", "s_aaaa1"]);
  });
});
