import type { Session } from "@renki/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { useClient } from "./client.js";

/** A live push about one session: the session as it is now, or null once it's gone. */
type Push = { id: string; session: Session | null };

function applyPush(list: Session[], { id, session }: Push): Session[] {
  if (!session) return list.filter((s) => s.id !== id);
  const idx = list.findIndex((s) => s.id === id);
  if (idx === -1) return [session, ...list];
  const next = list.slice();
  next[idx] = session;
  return next;
}

/**
 * The session list, fetched over REST every `pollMs` (and on `refresh()`),
 * and kept current between fetches by the WebSocket's pushes.
 *
 * A push that lands while a fetch is in flight is newer than what that fetch
 * will return (the server built its answer first), so it's replayed on top of
 * the answer. Taking the answer as-is put a session back to "busy" after it
 * had gone idle, or brought back one just deleted, until the next poll.
 *
 * `patch` changes one session locally ahead of the daemon (an optimistic
 * rename); the next push or fetch overwrites it with what the daemon says.
 */
export function useLiveSessions(pollMs: number): {
  sessions: Session[] | null;
  refresh: () => void;
  patch: (id: string, fields: Partial<Session>) => void;
} {
  const { rest, realtime } = useClient();
  const [sessions, setSessions] = useState<Session[] | null>(null);
  /** Pushes since the oldest fetch still in flight; empty when none is. */
  const log = useRef<Push[]>([]);
  /** Where each in-flight fetch started in `log`. */
  const inFlight = useRef(new Map<number, number>());
  const nextFetch = useRef(0);

  const refresh = useCallback(() => {
    const id = nextFetch.current++;
    inFlight.current.set(id, log.current.length);
    const done = () => {
      inFlight.current.delete(id);
      if (inFlight.current.size === 0) log.current = [];
    };
    rest
      .listSessions()
      .then((list) => {
        const since = log.current.slice(inFlight.current.get(id) ?? log.current.length);
        setSessions(since.reduce(applyPush, list));
      })
      .catch(() => {})
      .finally(done);
  }, [rest]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, pollMs);
    return () => clearInterval(t);
  }, [refresh, pollMs]);

  useEffect(() => {
    const push = (p: Push) => {
      if (inFlight.current.size > 0) log.current.push(p);
      setSessions((prev) => (prev ? applyPush(prev, p) : prev));
    };
    const offChanged = realtime.onSessionChanged((session) => push({ id: session.id, session }));
    const offRemoved = realtime.onSessionRemoved((id) => push({ id, session: null }));
    return () => {
      offChanged();
      offRemoved();
    };
  }, [realtime]);

  const patch = useCallback((id: string, fields: Partial<Session>) => {
    setSessions((prev) => prev && prev.map((s) => (s.id === id ? { ...s, ...fields } : s)));
  }, []);

  return { sessions, refresh, patch };
}
