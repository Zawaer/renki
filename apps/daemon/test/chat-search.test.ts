import type { EventPayload } from "@renki/protocol";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { DB } from "../src/db/index.js";
import { events, sessions } from "../src/db/schema.js";
import { EventLog } from "../src/events/log.js";
import { snippetAround } from "../src/events/search.js";
import { makeTestDb } from "./helpers.js";

function addSession(db: DB, id: string, title: string, status = "idle") {
  const now = Date.now();
  db.insert(sessions)
    .values({ id, repoName: "renki", repoId: "r1", worktreePath: `/tmp/${id}`, status, title, createdAt: now, updatedAt: now, lastActivityAt: now })
    .run();
}

const prompt = (text: string, promptId = "p1"): EventPayload => ({ kind: "prompt_submitted", promptId, deviceId: "d1", text });
const reply = (text: string, turnId = "t1", blockIndex = 0): EventPayload => ({
  kind: "assistant_block",
  turnId,
  blockIndex,
  blockKind: "text",
  text,
  toolUseId: null,
  toolName: null,
  toolInput: null,
});

describe("chat search", () => {
  it("finds any substring of a prompt or a reply, case-insensitively, and says where it is", () => {
    const db = makeTestDb();
    addSession(db, "s1", "Token stats");
    const log = new EventLog(db);
    log.append("s1", prompt("Why is the Total Tokens tile so low?"));
    log.append("s1", reply("Cache reads are left out of the total.", "t1", 2));
    log.append("s1", { ...reply("thinking about cache"), blockKind: "thinking" });

    const you = log.search.search("total tok");
    expect(you.hits).toHaveLength(1);
    expect(you.hits[0]).toMatchObject({ sessionId: "s1", sessionTitle: "Token stats", role: "you", promptId: "p1", turnId: null });

    const claude = log.search.search("CACHE READS");
    expect(claude.hits).toHaveLength(1);
    expect(claude.hits[0]).toMatchObject({ role: "claude", turnId: "t1", blockIndex: 2, promptId: null });
    const h = claude.hits[0]!;
    expect(h.snippet.slice(h.matchStart, h.matchStart + h.matchLength)).toBe("Cache reads");
  });

  it("handles one- and two-character queries and LIKE wildcards literally", () => {
    const db = makeTestDb();
    addSession(db, "s1", "x");
    const log = new EventLog(db);
    log.append("s1", prompt("grow by 50% now", "p1"));
    log.append("s1", prompt("grow by 50 now", "p2"));

    expect(log.search.search("%").hits.map((h) => h.promptId)).toEqual(["p1"]);
    expect(log.search.search("50%").hits.map((h) => h.promptId)).toEqual(["p1"]);
    expect(log.search.search("  ").hits).toEqual([]);
  });

  it("indexes history already in the log on first start", () => {
    const db = makeTestDb();
    addSession(db, "s1", "old");
    new EventLog(db).append("s1", prompt("an old hackathon question"));
    db.run(sql`DELETE FROM chat_text`); // a database from before the index existed

    expect(new EventLog(db).search.search("hackathon").hits).toHaveLength(1);
  });

  it("leaves out trashed sessions, and forgets a deleted transcript", () => {
    const db = makeTestDb();
    addSession(db, "s1", "kept");
    addSession(db, "s2", "binned", "trashed");
    const log = new EventLog(db);
    log.append("s1", prompt("needle one"));
    log.append("s2", prompt("needle two"));
    expect(log.search.search("needle").hits.map((h) => h.sessionId)).toEqual(["s1"]);

    log.deleteTranscript("s1");
    expect(log.search.search("needle").hits).toEqual([]);
    expect(db.select().from(events).where(eq(events.sessionId, "s1")).all()).toEqual([]);
  });
});

describe("snippetAround", () => {
  it("cuts a long message down to the match, on one line, with ellipses", () => {
    const text = `${"a ".repeat(100)}\n\nthe needle here\n${"b ".repeat(100)}`;
    const s = snippetAround(text, "needle");
    expect(s.snippet.startsWith("…")).toBe(true);
    expect(s.snippet.endsWith("…")).toBe(true);
    expect(s.snippet).not.toContain("\n");
    expect(s.snippet.slice(s.matchStart, s.matchStart + s.matchLength)).toBe("needle");
  });
});
