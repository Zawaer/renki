import { activeSessions, displayBranch, formatPurgeCountdown, groupByRepo, trashedSessions } from "@crc/client-core";
import type { Session } from "@crc/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useClient } from "../lib/client.js";
import { NewSessionDialog } from "./NewSessionDialog.js";
import { Button, Eyebrow, SessionGlyph, Skeleton } from "./ui.js";

/**
 * Session list, grouped by repo. Initial load (and an occasional slow
 * re-fetch, as a safety net for anything missed mid-disconnect) comes from
 * REST; after that it stays live off the daemon's fleet-wide
 * `session`/`session_removed` WS pushes, so a status/permission change shows
 * up immediately instead of waiting on a poll.
 *
 * Grouping is automatic — the repo IS the folder. Rows are a single line
 * (glyph + title); the repo lives in the group header and an auto-generated
 * `crc/xxxxxx` branch is deliberately not shown (see client-core's
 * isAutoBranch). Collapsed groups roll their children's state up into the
 * header so a folded repo that needs an approval still reads as such.
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
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState<{ repoId?: string } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [showArchived, setShowArchived] = useState(false);
  const [showTrash, setShowTrash] = useState(false);

  const refresh = useCallback(() => {
    rest
      .listSessions()
      .then((list) => {
        setSessions(list);
        setLoaded(true);
      })
      .catch(() => {});
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

  const active = useMemo(() => activeSessions(sessions), [sessions]);
  const archived = useMemo(
    () => sessions.filter((s) => s.status === "archived").sort((a, b) => b.lastActivityAt - a.lastActivityAt),
    [sessions],
  );
  // Soonest deadline first: the bin is a queue of things about to be lost.
  const trashed = useMemo(() => trashedSessions(sessions), [sessions]);
  const groups = useMemo(() => groupByRepo(active), [active]);

  function toggleGroup(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveCollapsed(next);
      return next;
    });
  }

  async function archive(id: string) {
    await rest.archiveSession(id);
    refresh();
  }

  async function rename(id: string, title: string) {
    await rest.renameSession(id, title);
    refresh();
  }

  /**
   * The ordinary delete, which now moves the session to the trash. The confirm
   * stays and says exactly what survives: the transcript is recoverable for a
   * month, the worktree and branch are not — they go now, as with archiving.
   */
  async function del(id: string) {
    if (!confirm("Move to trash? The transcript stays restorable for 30 days. The worktree and branch are cleaned up now."))
      return;
    await rest.trashSession(id);
    onDeleted(id);
    refresh();
  }

  async function restore(id: string) {
    await rest.restoreSession(id);
    refresh();
  }

  async function purge(id: string) {
    if (!confirm("Delete permanently? The transcript goes too, with no undo.")) return;
    await rest.purgeSession(id);
    onDeleted(id);
    refresh();
  }

  async function emptyTrash() {
    if (!confirm(`Permanently delete ${trashed.length} session${trashed.length === 1 ? "" : "s"}? There's no undo.`))
      return;
    await rest.emptyTrash();
    for (const s of trashed) onDeleted(s.id);
    refresh();
  }

  const rowProps = (s: Session) => ({
    session: s,
    selected: s.id === selectedId,
    onSelect: () => onSelect(s.id),
    onRename: (title: string) => rename(s.id, title),
    onDelete: () => del(s.id),
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <span className="text-sm font-semibold tracking-tight text-(--crc-fg)">Sessions</span>
        <Button variant="primary" size="sm" onClick={() => setCreating({})}>
          <span className="codicon codicon-add" /> New
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {!loaded && sessions.length === 0 && (
          <div className="space-y-4 px-1 pt-1" aria-busy="true" aria-label="Loading sessions">
            {[3, 2].map((n, g) => (
              <div key={g}>
                <div className="flex items-center gap-1.5 px-2 py-1.5">
                  <Skeleton className="h-2.5 w-2.5" />
                  <Skeleton className="h-2.5 w-20" />
                </div>
                {Array.from({ length: n }, (_, i) => (
                  <div key={i} className="flex items-center gap-2.5 px-2 py-2">
                    <Skeleton className="h-3.5 w-3.5 rounded-full" />
                    <Skeleton className={`h-3 ${i % 2 ? "w-36" : "w-44"}`} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        {loaded && active.length === 0 && (
          <div className="mx-1 mt-2 rounded-xl border border-dashed border-(--crc-border) px-3 py-6 text-center">
            <div className="text-sm text-(--crc-fg)">No active sessions</div>
            <div className="mt-1 text-xs text-(--crc-fg-muted)">Start one with the New button.</div>
          </div>
        )}

        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.key);
          return (
            <div key={g.key} className="mt-1.5">
              <div className="group/hdr flex items-center gap-0.5 pr-1">
                <button
                  onClick={() => toggleGroup(g.key)}
                  className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left hover:bg-(--crc-hover)"
                  title={isCollapsed ? "Expand" : "Collapse"}
                >
                  <span
                    className={`codicon codicon-chevron-right shrink-0 text-[11px] text-(--crc-fg-muted) transition-transform duration-150 ${
                      isCollapsed ? "" : "rotate-90"
                    }`}
                  />
                  <span className="truncate text-xs font-semibold text-(--crc-fg-muted)">{g.name}</span>
                  {isCollapsed && (
                    <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-(--crc-fg-muted)">
                      {g.pending > 0 ? (
                        <span className="flex items-center gap-1 text-(--crc-danger)">
                          <span className="h-1.5 w-1.5 rounded-full bg-(--crc-danger) crc-glow-danger animate-pulse" />
                          {g.pending}
                        </span>
                      ) : g.busy > 0 ? (
                        <span className="flex items-center gap-1 text-(--crc-warning)">
                          <span className="h-1.5 w-1.5 rounded-full bg-(--crc-warning) animate-pulse" />
                          {g.busy}
                        </span>
                      ) : null}
                      <span>{g.sessions.length}</span>
                    </span>
                  )}
                </button>
                {g.repoId && (
                  <button
                    onClick={() => setCreating({ repoId: g.repoId ?? undefined })}
                    title={`New session in ${g.name}`}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-(--crc-fg-muted) opacity-0 transition-opacity group-hover/hdr:opacity-100 hover:bg-(--crc-hover) hover:text-(--crc-fg) focus-visible:opacity-100"
                  >
                    <span className="codicon codicon-add text-[12px]" />
                  </button>
                )}
              </div>
              {!isCollapsed && (
                <div className="space-y-px">
                  {g.sessions.map((s) => (
                    <Row key={s.id} {...rowProps(s)} onArchive={() => archive(s.id)} />
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {trashed.length > 0 && (
          <div className="mt-4">
            <div className="flex items-center">
              <button
                onClick={() => setShowTrash((v) => !v)}
                className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left hover:bg-(--crc-hover)"
              >
                <span
                  className={`codicon codicon-chevron-right text-[11px] text-(--crc-fg-muted) transition-transform duration-150 ${
                    showTrash ? "rotate-90" : ""
                  }`}
                />
                <Eyebrow>Trash</Eyebrow>
                <span className="ml-auto text-[11px] text-(--crc-fg-muted)">{trashed.length}</span>
              </button>
              {showTrash && (
                <button
                  onClick={emptyTrash}
                  title="Delete everything in the trash permanently"
                  className="mr-1 shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-(--crc-fg-muted) hover:bg-(--crc-danger)/12 hover:text-(--crc-danger)"
                >
                  Empty
                </button>
              )}
            </div>
            {showTrash && (
              <div className="space-y-px">
                {trashed.map((s) => (
                  <Row
                    key={s.id}
                    {...rowProps(s)}
                    onRestore={() => restore(s.id)}
                    onPurge={() => purge(s.id)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {archived.length > 0 && (
          <div className="mt-4">
            <button
              onClick={() => setShowArchived((v) => !v)}
              className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left hover:bg-(--crc-hover)"
            >
              <span
                className={`codicon codicon-chevron-right text-[11px] text-(--crc-fg-muted) transition-transform duration-150 ${
                  showArchived ? "rotate-90" : ""
                }`}
              />
              <Eyebrow>Archived</Eyebrow>
              <span className="ml-auto text-[11px] text-(--crc-fg-muted)">{archived.length}</span>
            </button>
            {showArchived && (
              <div className="space-y-px">
                {archived.map((s) => (
                  <Row key={s.id} {...rowProps(s)} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {creating && (
        <NewSessionDialog
          initialRepoId={creating.repoId}
          onClose={() => setCreating(null)}
          onCreated={(session) => {
            setCreating(null);
            refresh();
            realtime.takeControl(session.id);
            onSelect(session.id);
          }}
        />
      )}
    </div>
  );
}

const COLLAPSED_KEY = "crc.sidebar.collapsed";

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(keys: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...keys]));
  } catch {
    // Storage unavailable (private mode, quota) — collapsing just won't persist.
  }
}

function Row({
  session,
  selected,
  onSelect,
  onArchive,
  onRename,
  onDelete,
  onRestore,
  onPurge,
}: {
  session: Session;
  selected: boolean;
  onSelect: () => void;
  onArchive?: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
  /** Both passed only for a row in the trash, which offers those two instead of archive/delete. */
  onRestore?: () => void;
  onPurge?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const branch = displayBranch(session.branch);
  const inTrash = session.status === "trashed";
  const countdown = formatPurgeCountdown(session.purgeAt);

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
      className={`group flex w-full items-center gap-1 rounded-lg py-1 pr-1 pl-2 transition-colors ${
        selected ? "bg-(--crc-selected) text-(--crc-selected-fg)" : "hover:bg-(--crc-hover)"
      } ${session.status === "archived" || inTrash ? "opacity-70" : ""}`}
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
        <button
          onClick={onSelect}
          className="flex h-7 min-w-0 flex-1 items-center gap-2.5 text-left"
          title={branch ? `${session.repoName} · ${branch}` : session.repoName}
        >
          <SessionGlyph status={session.status} pendingPermission={session.hasPendingPermission} />
          <span className="truncate text-[13px] text-(--crc-fg)">{session.title || session.repoName}</span>
          {/* In the bin, the deadline is the only thing worth the row's spare
              space — the branch is still there, which is the point, but it
              isn't what you came to check. */}
          {inTrash && countdown ? (
            <span className="ml-auto shrink-0 text-[10px] text-(--crc-fg-muted)">{countdown}</span>
          ) : (
            branch && (
              <span className="ml-auto max-w-24 shrink-0 truncate font-mono text-[10px] text-(--crc-fg-muted)">{branch}</span>
            )
          )}
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
            menuOpen ? "bg-(--crc-bg-inset) text-(--crc-fg)" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          }`}
        >
          <span className="codicon codicon-kebab-vertical" />
        </button>

        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
            <div
              className="crc-enter absolute top-full right-0 z-50 mt-1 w-44 overflow-hidden rounded-xl border border-(--crc-border) bg-(--crc-surface) p-1 text-sm shadow-(--crc-shadow-lg)"
              onClick={(e) => e.stopPropagation()}
            >
              {onRestore && (
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onRestore();
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-(--crc-fg) hover:bg-(--crc-hover)"
                >
                  <span className="codicon codicon-history" /> Restore
                </button>
              )}
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
              {!inTrash && (
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    startRename();
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-(--crc-fg) hover:bg-(--crc-hover)"
                >
                  <span className="codicon codicon-edit" /> Edit title
                </button>
              )}
              {onPurge ? (
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onPurge();
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-(--crc-danger) hover:bg-(--crc-danger)/12"
                >
                  <span className="codicon codicon-trash" /> Delete permanently
                </button>
              ) : (
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onDelete();
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-(--crc-danger) hover:bg-(--crc-danger)/12"
                >
                  <span className="codicon codicon-trash" /> Delete
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
