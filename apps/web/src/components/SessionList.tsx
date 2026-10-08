import { activeSessions, displayBranch, formatPurgeCountdown, groupByRepo, trashedSessions } from "@renki/client-core";
import type { Session } from "@renki/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { clearComposerPrefs, clearDraft } from "../lib/composerPrefs.js";
import { useClient } from "../lib/client.js";
import { NewSessionDialog } from "./NewSessionDialog.js";
import { Button, Eyebrow, Reveal, SessionGlyph, Skeleton } from "./ui.js";

/**
 * Session list, grouped by repo. Initial load (and an occasional slow
 * re-fetch, as a safety net for anything missed mid-disconnect) comes from
 * REST; after that it stays live off the daemon's fleet-wide
 * `session`/`session_removed` WS pushes, so a status/permission change shows
 * up immediately instead of waiting on a poll.
 *
 * Grouping is automatic — the repo IS the folder. Rows are a single line
 * (glyph + title); the repo lives in the group header and an auto-generated
 * `renki/xxxxxx` branch is deliberately not shown (see client-core's
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

  /** Archived → idle: its worktree is rebuilt and it takes prompts again. */
  async function unarchive(id: string) {
    try {
      await rest.unarchiveSession(id);
      onSelect(id);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Couldn't unarchive this session.");
    }
    refresh();
  }

  async function restore(id: string) {
    await rest.restoreSession(id);
    refresh();
  }

  async function purge(id: string) {
    if (!confirm("Delete permanently? The transcript goes too, with no undo.")) return;
    await rest.purgeSession(id);
    forgetLocally(id);
    onDeleted(id);
    refresh();
  }

  async function emptyTrash() {
    if (!confirm(`Permanently delete ${trashed.length} session${trashed.length === 1 ? "" : "s"}? There's no undo.`))
      return;
    await rest.emptyTrash();
    for (const s of trashed) {
      forgetLocally(s.id);
      onDeleted(s.id);
    }
    refresh();
  }

  /**
   * Drop what this browser remembered about a session that no longer exists —
   * its half-typed draft and its composer picks. Nothing reads them again, so
   * they'd sit in localStorage forever, taking room from the drafts of
   * sessions that DO exist.
   */
  function forgetLocally(id: string) {
    clearDraft(id);
    clearComposerPrefs(id);
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
        <span className="text-sm font-semibold tracking-tight text-(--renki-fg)">Sessions</span>
        <Button variant="primary" size="sm" onClick={() => setCreating({})}>
          <span className="codicon codicon-add" /> New
        </Button>
      </div>

      <div className="@container flex-1 overflow-x-hidden overflow-y-auto px-2 pb-3">
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
          <div className="mx-1 mt-2 rounded-xl border border-dashed border-(--renki-border) px-3 py-6 text-center">
            <div className="text-sm text-(--renki-fg)">No active sessions</div>
            <div className="mt-1 text-xs text-(--renki-fg-muted)">Start one with the New button.</div>
          </div>
        )}

        {/* Crossfades in over the skeleton once the first fetch lands. */}
        <div key={loaded ? "loaded" : "loading"} className={loaded ? "renki-fade" : ""}>
        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.key);
          return (
            <div key={g.key} className="mt-1.5">
              <div className="group/hdr flex items-center gap-0.5 pr-1">
                <button
                  onClick={() => toggleGroup(g.key)}
                  className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left hover:bg-(--renki-hover)"
                  title={isCollapsed ? "Expand" : "Collapse"}
                >
                  <span
                    className={`codicon codicon-chevron-right shrink-0 text-[11px] text-(--renki-fg-muted) transition-transform duration-150 ${
                      isCollapsed ? "" : "rotate-90"
                    }`}
                  />
                  <span className="truncate text-xs font-semibold text-(--renki-fg-muted)">{g.name}</span>
                  {isCollapsed && (
                    <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-(--renki-fg-muted)">
                      {g.pending > 0 ? (
                        <span className="flex items-center gap-1 text-(--renki-danger)">
                          <span className="h-1.5 w-1.5 rounded-full bg-(--renki-danger) renki-glow-danger animate-pulse" />
                          {g.pending}
                        </span>
                      ) : g.busy > 0 ? (
                        <span className="flex items-center gap-1 text-(--renki-warning)">
                          <span className="h-1.5 w-1.5 rounded-full bg-(--renki-warning) animate-pulse" />
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
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-(--renki-fg-muted) opacity-0 transition-opacity group-hover/hdr:opacity-100 hover:bg-(--renki-hover) hover:text-(--renki-fg) focus-visible:opacity-100"
                  >
                    <span className="codicon codicon-add text-[12px]" />
                  </button>
                )}
              </div>
              <Reveal open={!isCollapsed}>
                <div className="space-y-px">
                  {g.sessions.map((s) => (
                    <Row key={s.id} {...rowProps(s)} onArchive={() => archive(s.id)} />
                  ))}
                </div>
              </Reveal>
            </div>
          );
        })}
        </div>

        {trashed.length > 0 && (
          <div className="mt-4">
            <div className="flex items-center">
              <button
                onClick={() => setShowTrash((v) => !v)}
                className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left hover:bg-(--renki-hover)"
              >
                <span
                  className={`codicon codicon-chevron-right text-[11px] text-(--renki-fg-muted) transition-transform duration-150 ${
                    showTrash ? "rotate-90" : ""
                  }`}
                />
                <Eyebrow>Trash</Eyebrow>
                <span className="ml-auto text-[11px] text-(--renki-fg-muted)">{trashed.length}</span>
              </button>
              {showTrash && (
                <button
                  onClick={emptyTrash}
                  title="Delete everything in the trash permanently"
                  className="mr-1 shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-(--renki-fg-muted) hover:bg-(--renki-danger)/12 hover:text-(--renki-danger)"
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
              className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left hover:bg-(--renki-hover)"
            >
              <span
                className={`codicon codicon-chevron-right text-[11px] text-(--renki-fg-muted) transition-transform duration-150 ${
                  showArchived ? "rotate-90" : ""
                }`}
              />
              <Eyebrow>Archived</Eyebrow>
              <span className="ml-auto text-[11px] text-(--renki-fg-muted)">{archived.length}</span>
            </button>
            {showArchived && (
              <div className="space-y-px">
                {archived.map((s) => (
                  <Row key={s.id} {...rowProps(s)} onUnarchive={() => unarchive(s.id)} />
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

const COLLAPSED_KEY = "renki.sidebar.collapsed";

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
  onUnarchive,
  onRename,
  onDelete,
  onRestore,
  onPurge,
}: {
  session: Session;
  selected: boolean;
  onSelect: () => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
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
    // The title takes whatever width there is and fades out at its edge; the
    // ⋮ button floats over the row's right end on hover (as in the Claude
    // app), so a narrow sidebar clips the title, never the button. Dimming for
    // archived/trashed rows goes on the content only: on the whole row it
    // dimmed its menu too.
    <div
      className={`group relative flex w-full min-w-0 items-center rounded-lg py-1 pl-2 transition-colors ${
        selected ? "bg-(--renki-selected) text-(--renki-selected-fg)" : menuOpen ? "bg-(--renki-hover)" : "hover:bg-(--renki-hover)"
      } ${menuOpen ? "z-30" : ""}`}
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
            className="renki-input px-2 py-1 text-sm"
          />
        </div>
      ) : (
        <button
          onClick={onSelect}
          className={`flex h-7 min-w-0 flex-1 items-center gap-2.5 pr-1 text-left ${session.status === "archived" || inTrash ? "opacity-70" : ""}`}
          title={`${session.title || session.repoName}${branch ? ` · ${session.repoName} · ${branch}` : ""}`}
        >
          <SessionGlyph status={session.status} pendingPermission={session.hasPendingPermission} paused={!!session.resume} />
          <span
            className={`renki-fade-end min-w-0 flex-1 overflow-hidden text-[13px] whitespace-nowrap text-(--renki-fg) ${
              menuOpen ? "renki-fade-end-wide" : "group-hover:renki-fade-end-wide"
            }`}
          >
            {session.title || session.repoName}
          </span>
          {/* In the bin, the deadline is the only thing worth the row's spare
              space — the branch is still there, which is the point, but it
              isn't what you came to check. */}
          {/* Details on the right give way to the ⋮ button on hover, and the
              branch drops out entirely once the sidebar gets narrow. */}
          <span className={`flex shrink-0 items-center gap-1.5 transition-opacity ${menuOpen ? "opacity-0" : "group-hover:opacity-0"}`}>
            {inTrash && countdown ? (
              <span className="text-[10px] text-(--renki-fg-muted)">{countdown}</span>
            ) : (
              branch && (
                <span className="hidden max-w-24 truncate font-mono text-[10px] text-(--renki-fg-muted) @min-[15rem]:inline">{branch}</span>
              )
            )}
            {session.controller && (
              <span className="codicon codicon-lock-small text-(--renki-fg-muted)" title="A device holds control" />
            )}
          </span>
        </button>
      )}

      {/* Above the rows after it while its menu is open (z-30 on the row):
          every row is positioned, and later ones would otherwise paint over it. */}
      <div className="absolute inset-y-0 right-1 flex items-center">
        <button
          onClick={() => setMenuOpen((v) => !v)}
          title="Session actions"
          aria-label="Session actions"
          className={`flex h-6 w-6 items-center justify-center rounded-md text-(--renki-fg-muted) transition-opacity hover:bg-(--renki-bg-inset) hover:text-(--renki-fg) ${
            menuOpen ? "bg-(--renki-bg-inset) text-(--renki-fg)" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          }`}
        >
          <span className="codicon codicon-kebab-vertical" />
        </button>

        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
            <div
              className="renki-enter absolute top-full right-0 z-50 mt-1 w-44 overflow-hidden rounded-xl border border-(--renki-border) bg-(--renki-surface) p-1 text-sm shadow-(--renki-shadow-lg)"
              onClick={(e) => e.stopPropagation()}
            >
              {onRestore && (
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onRestore();
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-(--renki-fg) hover:bg-(--renki-hover)"
                >
                  <span className="codicon codicon-history" /> Restore
                </button>
              )}
              {onUnarchive && (
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onUnarchive();
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-(--renki-fg) hover:bg-(--renki-hover)"
                >
                  <span className="codicon codicon-reply" /> Unarchive
                </button>
              )}
              {onArchive && (
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onArchive();
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-(--renki-fg) hover:bg-(--renki-hover)"
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
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-(--renki-fg) hover:bg-(--renki-hover)"
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
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-(--renki-danger) hover:bg-(--renki-danger)/12"
                >
                  <span className="codicon codicon-trash" /> Delete permanently
                </button>
              ) : (
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onDelete();
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-(--renki-danger) hover:bg-(--renki-danger)/12"
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
