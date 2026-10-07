import type { EventPayload, SearchHit, SearchResponse } from "@renki/protocol";
import { sql } from "drizzle-orm";
import type { DB } from "../db/index.js";

/**
 * Full-text search over what was said in chats: every prompt you sent and
 * every block of Claude's reply text. Tool calls, tool output and thinking
 * aren't indexed — they're mostly file contents and command noise that would
 * bury the conversation itself.
 *
 * It lives in its own FTS5 table (see schema.ts's DDL) rather than querying
 * `events` directly: prompts carry their image attachments inline, so the log
 * is hundreds of megabytes of mostly base64, and scanning it per keystroke
 * gets slower with every screenshot. The trigram tokenizer makes the index
 * match any substring — part of a word, a path, a snippet of code — not just
 * whole words.
 *
 * Kept in step with the log by EventLog: append() indexes, deleteTranscript()
 * forgets. The first start after this table existed fills it from history.
 */
export class ChatSearch {
  constructor(private readonly db: DB) {}

  /**
   * Fill the index from the event log if it's empty. Runs once in practice:
   * after that, append() keeps it current, and an empty index with an empty
   * log costs one count.
   */
  backfillIfEmpty(): void {
    const row = this.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM chat_text`);
    if (row.n > 0) return;
    this.db.run(sql`
      INSERT INTO chat_text (text, session_id, seq, ts, anchor, role)
      SELECT json_extract(data, '$.text'), session_id, seq, ts,
             'p:' || json_extract(data, '$.promptId'), 'you'
        FROM events
       WHERE kind = 'prompt_submitted' AND length(json_extract(data, '$.text')) > 0
      UNION ALL
      SELECT json_extract(data, '$.text'), session_id, seq, ts,
             'b:' || json_extract(data, '$.turnId') || ':' || json_extract(data, '$.blockIndex'), 'claude'
        FROM events
       WHERE kind = 'assistant_block' AND json_extract(data, '$.blockKind') = 'text'
         AND length(json_extract(data, '$.text')) > 0
    `);
  }

  /** Index one freshly appended event, if it's chat text. */
  index(sessionId: string, seq: number, ts: number, payload: EventPayload): void {
    const doc = searchable(payload);
    if (!doc) return;
    this.db.run(sql`
      INSERT INTO chat_text (text, session_id, seq, ts, anchor, role)
      VALUES (${doc.text}, ${sessionId}, ${seq}, ${ts}, ${doc.anchor}, ${doc.role})
    `);
  }

  /** Drop everything indexed for a session — its transcript is gone. */
  forget(sessionId: string): void {
    this.db.run(sql`DELETE FROM chat_text WHERE session_id = ${sessionId}`);
  }

  /**
   * Messages containing `raw` (case-insensitive), newest first. The query is
   * matched as one literal string, spaces and punctuation included — what you
   * type is what's found.
   */
  search(raw: string, limit = 200): SearchResponse {
    const query = raw.trim();
    if (!query) return { query, hits: [], truncated: false };

    // Trigram MATCH needs at least three characters; shorter queries fall
    // back to LIKE, a scan of the (text-only, so small) index.
    const where =
      [...query].length >= 3
        ? sql`chat_text MATCH ${`text : "${query.replaceAll('"', '""')}"`}`
        : sql`c.text LIKE ${`%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`} ESCAPE '\\'`;

    const rows = this.db.all<Row>(sql`
      SELECT c.text AS text, c.session_id AS sessionId, c.seq AS seq, c.ts AS ts,
             c.anchor AS anchor, c.role AS role,
             s.title AS sessionTitle, s.repo_name AS repoName, s.repo_id AS repoId
        FROM chat_text c JOIN sessions s ON s.id = c.session_id
       WHERE ${where} AND s.status NOT IN ('trashed', 'deleted')
       ORDER BY c.ts DESC, c.seq DESC
       LIMIT ${limit + 1}
    `);

    const hits = rows.slice(0, limit).map((r): SearchHit => {
      const { snippet, matchStart, matchLength } = snippetAround(r.text, query);
      return {
        sessionId: r.sessionId,
        sessionTitle: r.sessionTitle,
        repoName: r.repoName,
        repoId: r.repoId,
        seq: r.seq,
        ts: r.ts,
        role: r.role,
        ...parseAnchor(r.anchor),
        snippet,
        matchStart,
        matchLength,
      };
    });
    return { query, hits, truncated: rows.length > limit };
  }
}

type Row = {
  text: string;
  sessionId: string;
  seq: number;
  ts: number;
  anchor: string;
  role: "you" | "claude";
  sessionTitle: string | null;
  repoName: string;
  repoId: string | null;
};

/**
 * What of an event is worth indexing, and where it sits in the transcript:
 * `p:<promptId>` for a prompt, `b:<turnId>:<blockIndex>` for a reply block.
 */
function searchable(payload: EventPayload): { text: string; anchor: string; role: "you" | "claude" } | null {
  if (payload.kind === "prompt_submitted" && payload.text) {
    return { text: payload.text, anchor: `p:${payload.promptId}`, role: "you" };
  }
  if (payload.kind === "assistant_block" && payload.blockKind === "text" && payload.text) {
    return { text: payload.text, anchor: `b:${payload.turnId}:${payload.blockIndex}`, role: "claude" };
  }
  return null;
}

function parseAnchor(anchor: string): { promptId: string | null; turnId: string | null; blockIndex: number | null } {
  if (anchor.startsWith("p:")) return { promptId: anchor.slice(2), turnId: null, blockIndex: null };
  const sep = anchor.lastIndexOf(":");
  return { promptId: null, turnId: anchor.slice(2, sep), blockIndex: Number(anchor.slice(sep + 1)) };
}

const BEFORE = 60;
const AFTER = 140;

/**
 * A one-line window of `text` around the first match of `query`, whitespace
 * collapsed, with ellipses where it was cut. Falls back to the message's
 * opening when the match can't be located in JS (SQLite folds case slightly
 * differently for some non-ASCII letters).
 */
export function snippetAround(text: string, query: string): { snippet: string; matchStart: number; matchLength: number } {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at === -1) {
    const head = oneLine(text);
    return { snippet: head.length > BEFORE + AFTER ? `${head.slice(0, BEFORE + AFTER)}…` : head, matchStart: 0, matchLength: 0 };
  }
  const from = Math.max(0, at - BEFORE);
  const to = Math.min(text.length, at + query.length + AFTER);
  const before = (from > 0 ? "…" : "") + oneLine(text.slice(from, at)).trimStart();
  const match = oneLine(text.slice(at, at + query.length));
  const after = oneLine(text.slice(at + query.length, to)).trimEnd() + (to < text.length ? "…" : "");
  return { snippet: before + match + after, matchStart: before.length, matchLength: match.length };
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ");
}
