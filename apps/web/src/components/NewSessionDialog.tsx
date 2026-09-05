import type { Repo, Session } from "@crc/protocol";
import { useEffect, useState } from "react";
import { useClient } from "../lib/client.js";
import { Button } from "./ui.js";

/** Sentinel repoId value for "no repo" — a real repo's id is never empty. */
const NO_REPO = "";

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

  function pickRepo(id: string) {
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

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="crc-enter w-full max-w-md space-y-4 rounded-2xl border border-(--crc-border) bg-(--crc-surface) p-6 shadow-(--crc-shadow-lg)"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-(--crc-fg)">New session</h2>
          <p className="mt-0.5 text-xs text-(--crc-fg-muted)">Each session gets its own branch and worktree, so it never collides with another.</p>
        </div>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-(--crc-fg-muted)">Repository</span>
          <select value={repoId} onChange={(e) => pickRepo(e.target.value)} className="crc-input">
            <option value={NO_REPO}>No repo (just chat)</option>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>

        {repoId !== NO_REPO && (
          <>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-(--crc-fg-muted)">Base branch</span>
              <input value={baseBranch} onChange={(e) => changeBaseBranch(e.target.value)} className="crc-input" />
            </label>

            <label className="block space-y-1">
              <span className="text-xs font-medium text-(--crc-fg-muted)">New branch (optional)</span>
              <input
                value={newBranch}
                onChange={(e) => setNewBranch(e.target.value)}
                placeholder="auto: crc/xxxxxx"
                className="crc-input"
              />
            </label>
          </>
        )}

        <label className="block space-y-1">
          <span className="text-xs font-medium text-(--crc-fg-muted)">Title (optional)</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} className="crc-input" />
        </label>

        {error && <p className="text-sm text-(--crc-danger)">{error}</p>}

        {behindInfo && (
          <div className="space-y-2 rounded-xl border border-(--crc-warning)/30 bg-(--crc-warning)/8 p-3">
            <p className="text-sm text-(--crc-fg)">
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

        {!behindInfo && (
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy || (repoId !== NO_REPO && !baseBranch)} onClick={create}>
              {busy ? "Creating…" : "Create"}
            </Button>
          </div>
        )}

      </div>
    </div>
  );
}
