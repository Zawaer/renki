import { EventEmitter } from "node:events";
import type { EventPayload, RepoStatsBucket, SessionEvent, StatsBucket, StatsResponse } from "@crc/protocol";
import { and, asc, eq, gt, max } from "drizzle-orm";
import type { DB } from "../db/index.js";
import { events, sessions } from "../db/schema.js";

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
   * Cost/token/wait-time analytics across every session, built by scanning
   * every stored `turn_result` event. Buckets by UTC day ("2026-07-22") and
   * UTC month ("2026-07") so the grouping is stable regardless of viewer
   * timezone. A turn contributes to `turnCount`/duration even if its cost or
   * token fields came back null (e.g. an errored turn still cost wait time).
   */
  statsSummary(): StatsResponse {
    // Sessions are never hard-deleted, so this should resolve for every turn —
    // the "unknown" fallback below only guards against future data cleanup.
    const repoBySession = new Map<string, { repoId: string; repoName: string }>();
    for (const s of this.db.select({ id: sessions.id, repoId: sessions.repoId, repoName: sessions.repoName }).from(sessions).all()) {
      repoBySession.set(s.id, { repoId: s.repoId, repoName: s.repoName });
    }

    const rows = this.db
      .select({ sessionId: events.sessionId, ts: events.ts, data: events.data })
      .from(events)
      .where(eq(events.kind, "turn_result"))
      .all();

    const daily = new Map<string, StatsBucket>();
    const monthly = new Map<string, StatsBucket>();
    const byRepo = new Map<string, RepoStatsBucket>();
    const lifetime = emptyBucket("lifetime");
    let firstTurnAt: number | null = null;

    for (const row of rows) {
      const payload = JSON.parse(row.data) as Extract<EventPayload, { kind: "turn_result" }>;
      const iso = new Date(row.ts).toISOString();
      accumulate(bucketFor(daily, iso.slice(0, 10)), payload);
      accumulate(bucketFor(monthly, iso.slice(0, 7)), payload);
      accumulate(lifetime, payload);

      const repo = repoBySession.get(row.sessionId) ?? { repoId: "unknown", repoName: "Unknown repo" };
      accumulate(repoBucketFor(byRepo, repo), payload);

      if (firstTurnAt === null || row.ts < firstTurnAt) firstTurnAt = row.ts;
    }

    return {
      daily: [...daily.values()].sort((a, b) => a.key.localeCompare(b.key)),
      monthly: [...monthly.values()].sort((a, b) => a.key.localeCompare(b.key)),
      byRepo: [...byRepo.values()].sort((a, b) => b.costUsd - a.costUsd),
      lifetime,
      firstTurnAt,
    };
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

function emptyBucket(key: string): StatsBucket {
  return { key, costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, turnCount: 0 };
}

function bucketFor(map: Map<string, StatsBucket>, key: string): StatsBucket {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = emptyBucket(key);
    map.set(key, bucket);
  }
  return bucket;
}

function repoBucketFor(map: Map<string, RepoStatsBucket>, repo: { repoId: string; repoName: string }): RepoStatsBucket {
  let bucket = map.get(repo.repoId);
  if (!bucket) {
    bucket = { repoId: repo.repoId, repoName: repo.repoName, costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, turnCount: 0 };
    map.set(repo.repoId, bucket);
  }
  return bucket;
}

/** The numeric fields shared by every bucket shape (time-based or by-repo). */
type Accumulable = { costUsd: number; inputTokens: number; outputTokens: number; durationMs: number; turnCount: number };

function accumulate(bucket: Accumulable, payload: Extract<EventPayload, { kind: "turn_result" }>): void {
  bucket.costUsd += payload.costUsd ?? 0;
  bucket.inputTokens += payload.inputTokens ?? 0;
  bucket.outputTokens += payload.outputTokens ?? 0;
  bucket.durationMs += payload.durationMs ?? 0;
  bucket.turnCount += 1;
}
