import { EventEmitter } from "node:events";
import type { EventPayload, SessionEvent } from "@crc/protocol";
import { and, asc, eq, gt, max } from "drizzle-orm";
import type { DB } from "../db/index.js";
import { events } from "../db/schema.js";

/**
 * The EventLog is the daemon's single source of truth for session activity.
 *
 * append() does three things, atomically (no await between them, and
 * better-sqlite3 is synchronous, so no other JS can interleave):
 *   1. reserve the next per-session `seq`
 *   2. persist the event to SQLite
 *   3. notify live subscribers
 *
 * That ordering is the whole trick behind killing staleness: an event is
 * durable BEFORE anyone is told about it. A live subscriber and a cold
 * reconnecting client therefore converge on the exact same log — a reconnecting
 * client asks read(sessionId, afterSeq) and is guaranteed to get everything it
 * missed, because it's all already on disk.
 */
export class EventLog {
  private readonly emitter = new EventEmitter();
  /** In-memory head per session, seeded lazily from the DB. */
  private readonly heads = new Map<string, number>();

  constructor(private readonly db: DB) {
    this.emitter.setMaxListeners(0); // many viewers per session; no cap
  }

  /** Append a new event, stamping it with the next seq + a timestamp. */
  append(sessionId: string, payload: EventPayload): SessionEvent {
    const seq = this.nextSeq(sessionId);
    const event = { seq, sessionId, ts: Date.now(), ...payload } as SessionEvent;

    this.db
      .insert(events)
      .values({ sessionId, seq, ts: event.ts, kind: payload.kind, data: JSON.stringify(payload) })
      .run();

    this.emitter.emit(channel(sessionId), event);
    this.emitter.emit(ANY, event);
    return event;
  }

  /** Read stored events for a session with seq strictly greater than `afterSeq`. */
  read(sessionId: string, afterSeq = -1): SessionEvent[] {
    const rows = this.db
      .select()
      .from(events)
      .where(and(eq(events.sessionId, sessionId), gt(events.seq, afterSeq)))
      .orderBy(asc(events.seq))
      .all();

    return rows.map(rowToEvent);
  }

  /** Current log head for a session (-1 if it has no events yet). */
  head(sessionId: string): number {
    return this.nextSeq(sessionId, /* peek */ true) - 1;
  }

  /**
   * Subscribe to live events for a session. Returns an unsubscribe function.
   * Note: this is LIVE only. Callers replay read() first, then subscribe, and
   * de-dup on seq to close the tiny gap between the two calls.
   */
  subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void {
    const ch = channel(sessionId);
    this.emitter.on(ch, listener);
    return () => this.emitter.off(ch, listener);
  }

  /** Subscribe to EVERY appended event across all sessions (used by the push notifier). */
  onAny(listener: (event: SessionEvent) => void): () => void {
    this.emitter.on(ANY, listener);
    return () => this.emitter.off(ANY, listener);
  }

  /**
   * Reserve (or peek) the next seq for a session. Seeds from DB the first time
   * we touch a session so seq keeps climbing across daemon restarts.
   */
  private nextSeq(sessionId: string, peek = false): number {
    let head = this.heads.get(sessionId);
    if (head === undefined) {
      const row = this.db
        .select({ m: max(events.seq) })
        .from(events)
        .where(eq(events.sessionId, sessionId))
        .get();
      head = row?.m ?? -1;
      this.heads.set(sessionId, head);
    }
    if (peek) return head + 1;
    const next = head + 1;
    this.heads.set(sessionId, next);
    return next;
  }
}

const ANY = "evt:*";

function channel(sessionId: string): string {
  return `evt:${sessionId}`;
}

function rowToEvent(row: {
  sessionId: string;
  seq: number;
  ts: number;
  data: string;
}): SessionEvent {
  const payload = JSON.parse(row.data) as EventPayload;
  return { seq: row.seq, sessionId: row.sessionId, ts: row.ts, ...payload } as SessionEvent;
}
