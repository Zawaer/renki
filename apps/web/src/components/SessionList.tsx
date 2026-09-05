import type { Session } from "@crc/protocol";
import { useCallback, useEffect, useState } from "react";
import { useClient } from "../lib/client.js";
import { NewSessionDialog } from "./NewSessionDialog.js";
import { Button, Eyebrow, StatusDot } from "./ui.js";

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
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <span className="text-sm font-semibold tracking-tight text-(--crc-fg)">Sessions</span>
        <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
          <span className="codicon codicon-add" /> New
        </Button>
      </div>

      <div className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
        {active.length === 0 && (
          <div className="mx-1 mt-2 rounded-xl border border-dashed border-(--crc-border) px-3 py-6 text-center">
            <div className="text-sm text-(--crc-fg)">No active sessions</div>
            <div className="mt-1 text-xs text-(--crc-fg-muted)">Start one with the New button.</div>
          </div>
        )}
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

        {archived.length > 0 && <Eyebrow className="mt-4 px-3 pt-2 pb-1.5">Archived</Eyebrow>}
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
      className={`group flex w-full items-center gap-2 rounded-lg px-3 py-2 transition-colors ${
        selected ? "bg-(--crc-selected) text-(--crc-selected-fg)" : "hover:bg-(--crc-hover)"
      } ${session.status === "archived" ? "opacity-70" : ""}`}
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
            className="crc-input px-2 py-1 text-sm"
          />
        </div>
      ) : (
        <button onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
          <StatusDot status={session.status} pendingPermission={session.hasPendingPermission} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-(--crc-fg)">{session.title || session.repoName}</div>
            <div className="mt-0.5 truncate font-mono text-[11px] text-(--crc-fg-muted)">
              {session.branch ? (
                <>
                  {session.repoName}
                  <span className="opacity-50"> / </span>
                  {session.branch}
                </>
              ) : (
                session.repoName
              )}
            </div>
          </div>
          {session.controller && (
            <span className="codicon codicon-lock-small shrink-0 text-(--crc-fg-muted)" title="A device holds control" />
          )}
        </button>
      )}

      <div className="relative shrink-0">
        <button
          onClick={() => setMenuOpen((v) => !v)}
          title="Session actions"
          className={`flex h-6 w-6 items-center justify-center rounded-md text-(--crc-fg-muted) hover:bg-(--crc-bg-inset) hover:text-(--crc-fg) ${
            menuOpen ? "bg-(--crc-bg-inset) text-(--crc-fg)" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          <span className="codicon codicon-kebab-vertical" />
        </button>

        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
            <div
              className="crc-enter absolute right-0 top-full z-50 mt-1 w-44 overflow-hidden rounded-xl border border-(--crc-border) bg-(--crc-surface) p-1 text-sm shadow-(--crc-shadow-lg)"
              onClick={(e) => e.stopPropagation()}
            >
              {onArchive && (
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onArchive();
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-(--crc-fg) hover:bg-(--crc-hover)"
                >
                  <span className="codicon codicon-archive" /> Archive
                </button>
              )}
              <button
                onClick={() => {
                  setMenuOpen(false);
                  startRename();
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-(--crc-fg) hover:bg-(--crc-hover)"
              >
                <span className="codicon codicon-edit" /> Edit title
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  onDelete();
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-(--crc-danger) hover:bg-(--crc-danger)/12"
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
