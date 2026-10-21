import type { GithubRepo } from "@renki/protocol";

/**
 * Pick a repo from GitHub that isn't on the host yet. Cloning is the point:
 * Renki can only start a session on a repo under its repos root, and getting one
 * there otherwise means an SSH session — the exact thing that stops you
 * starting work from a phone.
 */
export function GithubBrowser({
  gh,
  query,
  onQuery,
  cloning,
  alreadyCloned,
  onPick,
  onCancel,
}: {
  gh: { available: boolean; reason: string | null; repos: GithubRepo[] } | null;
  query: string;
  onQuery: (q: string) => void;
  cloning: string | null;
  alreadyCloned: Set<string>;
  onPick: (fullName: string) => void;
  onCancel: () => void;
}) {
  const q = query.trim().toLowerCase();
  const matches = (gh?.repos ?? []).filter((r) => !q || r.fullName.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q));
  // Anything typed that looks like a repo can be cloned even if it's not in the
  // list — an org repo the list didn't reach, or one you know by name.
  const typedRef = /^[\w.-]+\/[\w.-]+$/.test(query.trim()) ? query.trim() : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button onClick={onCancel} className="flex h-7 w-7 items-center justify-center rounded-lg text-(--renki-fg-muted) hover:bg-(--renki-hover) hover:text-(--renki-fg)" title="Back">
          <span className="codicon codicon-arrow-left" />
        </button>
        <span className="text-sm font-medium text-(--renki-fg)">Clone from GitHub</span>
      </div>

      {gh && !gh.available ? (
        <div className="rounded-xl bg-(--renki-bg-inset)/70 px-3.5 py-3 text-xs text-(--renki-fg-muted)">
          {gh.reason ?? "The daemon has no GitHub login."}
        </div>
      ) : (
        <>
          <input
            autoFocus
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search your repos, or type owner/name"
            spellCheck={false}
            className="renki-input"
          />
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {!gh && <div className="px-1 py-2 text-xs text-(--renki-fg-muted)">Loading your repos…</div>}
            {gh && matches.length === 0 && !typedRef && (
              <div className="px-1 py-2 text-xs text-(--renki-fg-muted)">Nothing matches. Type an exact owner/name to clone it anyway.</div>
            )}
            {typedRef && !matches.some((r) => r.fullName.toLowerCase() === typedRef.toLowerCase()) && (
              <RepoRow full={typedRef} description="Clone by name" cloned={false} busy={cloning === typedRef} onPick={onPick} />
            )}
            {matches.map((r) => (
              <RepoRow
                key={r.fullName}
                full={r.fullName}
                description={r.description}
                isPrivate={r.isPrivate}
                cloned={alreadyCloned.has(r.name.toLowerCase())}
                busy={cloning === r.fullName}
                onPick={onPick}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function RepoRow({
  full,
  description,
  isPrivate,
  cloned,
  busy,
  onPick,
}: {
  full: string;
  description?: string | null;
  isPrivate?: boolean;
  cloned: boolean;
  busy: boolean;
  onPick: (fullName: string) => void;
}) {
  return (
    <button
      onClick={() => onPick(full)}
      disabled={busy}
      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-(--renki-hover) disabled:opacity-60"
    >
      <span className={`codicon shrink-0 text-[13px] ${isPrivate ? "codicon-lock-small" : "codicon-repo"} text-(--renki-fg-muted)`} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-(--renki-fg)">{full}</span>
        {description && <span className="block truncate text-[11px] text-(--renki-fg-muted)">{description}</span>}
      </span>
      {busy ? (
        <span className="shrink-0 text-[11px] text-(--renki-fg-muted)">Cloning…</span>
      ) : cloned ? (
        <span className="shrink-0 text-[11px] text-(--renki-fg-muted)">Already here</span>
      ) : null}
    </button>
  );
}
