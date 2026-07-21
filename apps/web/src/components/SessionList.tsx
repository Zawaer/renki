import type { Session } from "@crc/protocol";
import { useCallback, useEffect, useState } from "react";
import { useClient } from "../lib/client.js";
import { NewSessionDialog } from "./NewSessionDialog.js";
import { Button, StatusDot } from "./ui.js";

/**
 * Session list. Sourced from REST and polled every few seconds. (Per-session
 * status you're actively viewing updates live via WS; the list poll just keeps
 * the roster fresh across devices — a proper `sessions` subscription is a
 * future protocol addition.)
 */
export function SessionList({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { rest } = useClient();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(() => {
    rest.listSessions().then(setSessions).catch(() => {});
  }, [rest]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  const active = sessions.filter((s) => s.status !== "archived");
  const archived = sessions.filter((s) => s.status === "archived");

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-(--crc-border) p-3">
        <span className="text-sm font-semibold text-(--crc-fg)">Sessions</span>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <span className="codicon codicon-add" /> New
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {active.length === 0 && <p className="p-4 text-sm text-(--crc-fg-muted)">No active sessions.</p>}
        {active.map((s) => (
          <Row key={s.id} session={s} selected={s.id === selectedId} onSelect={() => onSelect(s.id)} />
        ))}

        {archived.length > 0 && (
          <div className="mt-2 px-3 py-1 text-xs uppercase tracking-wide text-(--crc-fg-muted)">Archived</div>
        )}
        {archived.map((s) => (
          <Row key={s.id} session={s} selected={s.id === selectedId} onSelect={() => onSelect(s.id)} />
        ))}
      </div>

      {creating && (
        <NewSessionDialog
          onClose={() => setCreating(false)}
          onCreated={(session) => {
            setCreating(false);
            refresh();
            onSelect(session.id);
          }}
        />
      )}
    </div>
  );
}

function Row({ session, selected, onSelect }: { session: Session; selected: boolean; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      className={`flex w-full items-center gap-2 border-l-2 px-3 py-2.5 text-left ${
        selected
          ? "border-(--crc-focus) bg-(--crc-selected) text-(--crc-selected-fg)"
          : "border-transparent hover:bg-(--crc-hover)"
      }`}
    >
      <StatusDot status={session.status} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-(--crc-fg)">{session.title || session.repoName}</div>
        <div className="truncate text-xs text-(--crc-fg-muted)">
          {session.repoName}:{session.branch}
        </div>
      </div>
      {session.controller && <span className="codicon codicon-lock text-xs text-(--crc-link)" />}
    </button>
  );
}
