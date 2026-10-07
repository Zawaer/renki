import type { SearchHit } from "@renki/protocol";
import { describe, expect, it } from "vitest";
import { groupSearchHits, searchHitAnchor, splitSnippet } from "../src/search.js";

const hit = (over: Partial<SearchHit>): SearchHit => ({
  sessionId: "s1",
  sessionTitle: "Chat",
  repoName: "renki",
  repoId: "r1",
  seq: 1,
  ts: 1,
  role: "you",
  promptId: "p1",
  turnId: null,
  blockIndex: null,
  snippet: "find the needle here",
  matchStart: 9,
  matchLength: 6,
  ...over,
});

describe("groupSearchHits", () => {
  it("groups by chat in order of each chat's newest hit, and drops the repo label for repo-less chats", () => {
    const groups = groupSearchHits([
      hit({ sessionId: "a", seq: 3 }),
      hit({ sessionId: "b", sessionTitle: null, repoId: null, repoName: "(none)" }),
      hit({ sessionId: "a", seq: 1 }),
    ]);
    expect(groups.map((g) => [g.sessionId, g.hits.length])).toEqual([["a", 2], ["b", 1]]);
    expect(groups[1]).toMatchObject({ title: "Untitled chat", repoName: null });
  });
});

describe("searchHitAnchor / splitSnippet", () => {
  it("names a prompt or a reply block the way the chat view tags them", () => {
    expect(searchHitAnchor(hit({}))).toBe("p:p1");
    expect(searchHitAnchor(hit({ promptId: null, turnId: "t9", blockIndex: 4 }))).toBe("b:t9:4");
  });

  it("splits a snippet around its match", () => {
    expect(splitSnippet(hit({}))).toEqual(["find the ", "needle", " here"]);
  });
});
