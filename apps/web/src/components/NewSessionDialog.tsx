import type { GithubRepo, Repo, Session } from "@renki/protocol";
import { useEffect, useState } from "react";
import { useClient } from "../lib/client.js";
import { Button, Select } from "./ui.js";

/** Sentinel repoId value for "no repo" — a real repo's id is never empty. */
const NO_REPO = "";
/** Sentinel that opens the GitHub browser instead of selecting anything. */
const FROM_GITHUB = "__github";

/** Create a session: pick a repo (or "No repo" for a plain scratch dir), base branch, optional new-branch name + title. */
export function NewSessionDialog({
  initialRepoId,
  onClose,
  onCreated,
}: {
  /** Preselect this repo (the sidebar's per-repo "+"); falls back to the first repo when absent or unknown. */
  initialRepoId?: string;
  onClose: () => void;
  onCreated: (session: Session) => void;
}) {
  const { rest } = useClient();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repoId, setRepoId] = useState(NO_REPO);
  const [baseBranch, setBaseBranch] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [behindInfo, setBehindInfo] = useState<{ behind: number } | null>(null);
  // Base branch, new branch and title all have good defaults (the repo's own
  // default branch, an auto `renki/xxxxxx` worktree handle, and a title the
  // daemon generates from the first message), so they stay folded away.
  const [advanced, setAdvanced] = useState(false);
  // The GitHub browser: a repo you haven't checked out on the host yet is the
  // one case where "pick a repo" can't be answered from the repos root alone.
  const [browsing, setBrowsing] = useState(false);
  const [gh, setGh] = useState<{ available: boolean; reason: string | null; repos: GithubRepo[] } | null>(null);
  const [ghQuery, setGhQuery] = useState("");
  const [cloning, setCloning] = useState<string | null>(null);

  useEffect(() => {
    rest
      .listRepos()
      .then((r) => {
        setRepos(r);
        const preferred = (initialRepoId && r.find((x) => x.id === initialRepoId)) || r[0];
        if (preferred) {
          setRepoId(preferred.id);
          setBaseBranch(preferred.defaultBranch);
        }
      })
      .catch((e) => setError(String(e)));
  }, [rest, initialRepoId]);

  function openGithubBrowser() {
    setBrowsing(true);
    setError(null);
    if (gh) return;
    rest
      .listGithubRepos()
      .then((res) => setGh({ available: res.available, reason: res.reason, repos: res.repos }))
      .catch(() => setGh({ available: false, reason: "Couldn't reach the daemon.", repos: [] }));
  }

  /** Clone the picked repo, then fall straight through to selecting it. */
  async function cloneAndSelect(full: string) {
    setCloning(full);
    setError(null);
    try {
      const res = await rest.cloneGithubRepo(full);
      if (!res.ok || !res.repo) {
        setError(res.message ?? "Couldn't clone that repo.");
        return;
      }
      const cloned = res.repo;
      setRepos((prev) => (prev.some((r) => r.id === cloned.id) ? prev : [...prev, cloned].sort((a, b) => a.name.localeCompare(b.name))));
      setRepoId(cloned.id);
      setBaseBranch(cloned.defaultBranch);
      setBehindInfo(null);
      setBrowsing(false);
    } catch {
      setError("Couldn't reach the daemon.");
    } finally {
      setCloning(null);
    }
  }

  function pickRepo(id: string) {
    if (id === FROM_GITHUB) {
      openGithubBrowser();
      return;
    }
    setRepoId(id);
    const repo = repos.find((r) => r.id === id);
    setBaseBranch(repo?.defaultBranch ?? "");
    setBehindInfo(null);
  }

  function changeBaseBranch(value: string) {
    setBaseBranch(value);
    setBehindInfo(null);
  }

  /** Create button: check the base branch against origin first, and pause for confirmation if it's behind. */
  async function create() {
    if (repoId === NO_REPO) return submit();
    setBusy(true);
    setError(null);
    try {
      const status = await rest.getBranchStatus(repoId, baseBranch);
      if (status.hasRemote && status.behind > 0) {
        setBehindInfo({ behind: status.behind });
        setBusy(false);
        return;
      }
    } catch {
      // Best-effort check — if it fails (offline, no remote, etc.) just proceed to create.
    }
    await submit();
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const session = await rest.createSession(
        repoId === NO_REPO
          ? { title: title.trim() || undefined }
          : {
              repoId,
              baseBranch,
              newBranch: newBranch.trim() || undefined,
              title: title.trim() || undefined,
            },
      );
      onCreated(session);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create session.");
      setBusy(false);
    }
  }

  async function pullAndCreate() {
    setBehindInfo(null);
    setBusy(true);
    setError(null);
    try {
      await rest.pullBranch(repoId, baseBranch);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to pull.");
      setBusy(false);
      return;
    }
    await submit();
  }

  function skipAndCreate() {
    setBehindInfo(null);
    void submit();
  }

  const selectedRepo = repos.find((r) => r.id === repoId);
  const canCreate = !busy && (repoId === NO_REPO || Boolean(baseBranch));

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        else if (e.key === "Enter" && !e.shiftKey && canCreate && !behindInfo) {
          e.preventDefault();
          void create();
        }
      }}
    >
      <div
        className="renki-enter w-full max-w-md space-y-4 rounded-2xl border border-(--renki-border) bg-(--renki-surface) p-6 shadow-(--renki-shadow-lg)"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-(--renki-fg)">New session</h2>
          <p className="mt-0.5 text-xs text-(--renki-fg-muted)">
            {repoId === NO_REPO
              ? "A scratch directory with no git — just somewhere to think out loud."
              : "Gets its own branch and worktree, so it never collides with another session."}
          </p>
        </div>

        {browsing ? (
          <GithubBrowser
            gh={gh}
            query={ghQuery}
            onQuery={setGhQuery}
            cloning={cloning}
            alreadyCloned={new Set(repos.map((r) => r.name.toLowerCase()))}
            onPick={cloneAndSelect}
            onCancel={() => setBrowsing(false)}
          />
        ) : (
        <div className="space-y-1">
          <span className="block text-xs font-medium text-(--renki-fg-muted)">Repository</span>
          <Select
            value={repoId}
            onChange={pickRepo}
            options={[
              { value: NO_REPO, label: "No repo", description: "Just chat — a scratch directory, no git" },
              ...repos.map((r) => ({ value: r.id, label: r.name, description: r.defaultBranch })),
              { value: FROM_GITHUB, label: "Clone from GitHub…", description: "Start on a repo this host hasn't checked out yet" },
            ]}
          />
          {/* The defaults everyone actually uses, stated rather than asked for. */}
          {repoId !== NO_REPO && !advanced && (
            <p className="pt-1 text-[11px] text-(--renki-fg-muted)">
              Branches from <span className="font-mono">{baseBranch || selectedRepo?.defaultBranch}</span>
              {newBranch ? (
                <>
                  {" "}
                  onto <span className="font-mono">{newBranch}</span>
                </>
              ) : null}
              . Claude names the session from your first message.
            </p>
          )}
        </div>
        )}

        {!browsing && advanced && (
          <div className="space-y-4">
            {repoId !== NO_REPO && (
              <>
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-(--renki-fg-muted)">Base branch</span>
                  <input value={baseBranch} onChange={(e) => changeBaseBranch(e.target.value)} className="renki-input" />
                </label>

                <label className="block space-y-1">
                  <span className="text-xs font-medium text-(--renki-fg-muted)">New branch (optional)</span>
                  <input
                    value={newBranch}
                    onChange={(e) => setNewBranch(e.target.value)}
                    placeholder="auto: renki/xxxxxx"
                    className="renki-input"
                  />
                </label>
              </>
            )}

            <label className="block space-y-1">
              <span className="text-xs font-medium text-(--renki-fg-muted)">Title (optional)</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Auto-generated from your first message"
                className="renki-input"
              />
            </label>
          </div>
        )}

        {error && <p className="rounded-lg bg-(--renki-danger)/10 px-3 py-2 text-sm text-(--renki-danger)">{error}</p>}

        {!browsing && behindInfo && (
          <div className="space-y-2 rounded-xl border border-(--renki-warning)/30 bg-(--renki-warning)/8 p-3">
            <p className="text-sm text-(--renki-fg)">
              <span className="font-medium">{baseBranch}</span> is {behindInfo.behind} commit
              {behindInfo.behind === 1 ? "" : "s"} behind <span className="font-medium">origin/{baseBranch}</span>.
              Pull the latest before creating this session?
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" disabled={busy} onClick={skipAndCreate}>
                Skip
              </Button>
              <Button variant="primary" disabled={busy} onClick={pullAndCreate}>
                {busy ? "Pulling…" : "Pull & create"}
              </Button>
            </div>
          </div>
        )}

        {!browsing && !behindInfo && (
          <div className="flex items-center justify-between gap-2 pt-1">
            <button
              onClick={() => setAdvanced((v) => !v)}
              className="flex items-center gap-1 text-xs text-(--renki-fg-muted) transition-colors hover:text-(--renki-fg)"
            >
              <span
                className={`codicon codicon-chevron-right text-[11px] transition-transform duration-150 ${advanced ? "rotate-90" : ""}`}
              />
              Advanced
            </button>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" disabled={!canCreate} onClick={create}>
                {busy ? "Creating…" : "Create"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Pick a repo from GitHub that isn't on the host yet. Cloning is the point:
 * Renki can only start a session on a repo under its repos root, and getting one
 * there otherwise means an SSH session — the exact thing that stops you
 * starting work from a phone.
 */
function GithubBrowser({
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
