import type { Session } from "@crc/protocol";
import { useCallback, useEffect, useState } from "react";
import { useClient } from "../lib/client.js";
import { NewSessionDialog } from "./NewSessionDialog.js";
import { Button, StatusDot } from "./ui.js";

/**
 * Session list. Initial load (and an occasional slow re-fetch, as a safety
 * net for anything missed mid-disconnect) comes from REST; after that it
 * stays live off the daemon's fleet-wide `session`/`session_removed` WS
 * pushes, so a status/permission change shows up immediately instead of
 * waiting on a poll.
 */
export function SessionList({
  selectedId,
  onSelect,
  onDeleted,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDeleted: (id: string) => void;
}) {
  const { rest, realtime } = useClient();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(() => {
    rest.listSessions().then(setSessions).catch(() => {});
  }, [rest]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    const offChanged = realtime.onSessionChanged((session) => {
      setSessions((prev) => {
        const idx = prev.findIndex((s) => s.id === session.id);
        if (idx === -1) return [session, ...prev];
        const next = prev.slice();
        next[idx] = session;
        return next;
      });
    });
    const offRemoved = realtime.onSessionRemoved((id) => {
      setSessions((prev) => prev.filter((s) => s.id !== id));
    });
    return () => {
      offChanged();
      offRemoved();
    };
  }, [realtime]);

  const active = sessions.filter((s) => s.status !== "archived");
  const archived = sessions.filter((s) => s.status === "archived");

  async function archive(id: string) {
    await rest.archiveSession(id);
    refresh();
  }

  async function rename(id: string, title: string) {
    await rest.renameSession(id, title);
    refresh();
  }

  async function del(id: string) {
    if (!confirm("Delete this session? Its transcript will be gone for good.")) return;
    await rest.deleteSession(id);
    onDeleted(id);
    refresh();
  }

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
          <Row
            key={s.id}
            session={s}
            selected={s.id === selectedId}
            onSelect={() => onSelect(s.id)}
            onArchive={() => archive(s.id)}
            onRename={(title) => rename(s.id, title)}
            onDelete={() => del(s.id)}
          />
        ))}

        {archived.length > 0 && (
          <div className="mt-2 px-3 py-1 text-xs uppercase tracking-wide text-(--crc-fg-muted)">Archived</div>
        )}
        {archived.map((s) => (
          <Row
            key={s.id}
            session={s}
            selected={s.id === selectedId}
            onSelect={() => onSelect(s.id)}
            onRename={(title) => rename(s.id, title)}
            onDelete={() => del(s.id)}
          />
        ))}
      </div>

      {creating && (
        <NewSessionDialog
          onClose={() => setCreating(false)}
          onCreated={(session) => {
            setCreating(false);
            refresh();
            realtime.takeControl(session.id);
            onSelect(session.id);
          }}
        />
      )}
    </div>
  );
}

function Row({
  session,
  selected,
  onSelect,
  onArchive,
  onRename,
  onDelete,
}: {
  session: Session;
  selected: boolean;
  onSelect: () => void;
  onArchive?: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");

  function startRename() {
    setDraft(session.title ?? session.repoName);
    setRenaming(true);
  }

  function commitRename() {
    setRenaming(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== session.title) onRename(trimmed);
  }

  return (
    <div
      className={`group flex w-full items-center gap-2 border-l-2 px-3 py-2.5 ${
        selected
          ? "border-(--crc-focus) bg-(--crc-selected) text-(--crc-selected-fg)"
          : "border-transparent hover:bg-(--crc-hover)"
      }`}
    >
      {renaming ? (
        <div className="min-w-0 flex-1 py-px">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              else if (e.key === "Escape") setRenaming(false);
            }}
            className="w-full rounded-sm border border-(--crc-focus) bg-(--crc-bg-inset) px-1.5 py-0.5 text-sm text-(--crc-fg) outline-none"
          />
        </div>
      ) : (
        <button onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <StatusDot status={session.status} pendingPermission={session.hasPendingPermission} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm text-(--crc-fg)">{session.title || session.repoName}</div>
            <div className="truncate text-xs text-(--crc-fg-muted)">
              {session.branch ? `${session.repoName}:${session.branch}` : session.repoName}
            </div>
          </div>
          {session.controller && <span className="codicon codicon-lock text-xs text-(--crc-link)" />}
        </button>
      )}

      <div className="relative shrink-0">
        <button
          onClick={() => setMenuOpen((v) => !v)}
          title="Session actions"
          className={`rounded-sm p-1 text-(--crc-fg-muted) hover:bg-(--crc-hover) hover:text-(--crc-fg) ${
            menuOpen ? "bg-(--crc-hover) text-(--crc-fg)" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          <span className="codicon codicon-kebab-vertical" />
        </button>

        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
            <div
              className="absolute right-0 top-full z-50 mt-1 w-40 overflow-hidden rounded-sm border border-(--crc-border) bg-(--crc-bg-elevated) py-1 text-sm shadow-lg"
              onClick={(e) => e.stopPropagation()}
            >
              {onArchive && (
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onArchive();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-(--crc-fg) hover:bg-(--crc-hover)"
                >
                  <span className="codicon codicon-archive" /> Archive
                </button>
              )}
              <button
                onClick={() => {
                  setMenuOpen(false);
                  startRename();
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-(--crc-fg) hover:bg-(--crc-hover)"
              >
                <span className="codicon codicon-edit" /> Edit title
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  onDelete();
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-(--crc-danger) hover:bg-(--crc-danger)/15"
              >
                <span className="codicon codicon-trash" /> Delete
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
