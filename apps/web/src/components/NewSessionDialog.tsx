import type { Repo, Session } from "@crc/protocol";
import { useEffect, useState } from "react";
import { useClient } from "../lib/client.js";
import { Button } from "./ui.js";

/** Sentinel repoId value for "no repo" — a real repo's id is never empty. */
const NO_REPO = "";

/** Create a session: pick a repo (or "No repo" for a plain scratch dir), base branch, optional new-branch name + title. */
export function NewSessionDialog({
  onClose,
  onCreated,
}: {
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
        if (r[0]) {
          setRepoId(r[0].id);
          setBaseBranch(r[0].defaultBranch);
        }
      })
      .catch((e) => setError(String(e)));
  }, [rest]);

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
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md space-y-3 rounded-sm border border-(--crc-border) bg-(--crc-bg-elevated) p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-(--crc-fg)">New session</h2>

        <label className="block space-y-1">
          <span className="text-xs text-(--crc-fg-muted)">Repository</span>
          <select value={repoId} onChange={(e) => pickRepo(e.target.value)} className="ns-input">
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
              <span className="text-xs text-(--crc-fg-muted)">Base branch</span>
              <input value={baseBranch} onChange={(e) => changeBaseBranch(e.target.value)} className="ns-input" />
            </label>

            <label className="block space-y-1">
              <span className="text-xs text-(--crc-fg-muted)">New branch (optional)</span>
              <input
                value={newBranch}
                onChange={(e) => setNewBranch(e.target.value)}
                placeholder="auto: crc/xxxxxx"
                className="ns-input"
              />
            </label>
          </>
        )}

        <label className="block space-y-1">
          <span className="text-xs text-(--crc-fg-muted)">Title (optional)</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} className="ns-input" />
        </label>

        {error && <p className="text-sm text-(--crc-danger)">{error}</p>}

        {behindInfo && (
          <div className="space-y-2 rounded-sm border border-(--crc-border) bg-(--crc-bg-inset) p-3">
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

        <style>{`.ns-input{width:100%;border-radius:2px;border:1px solid var(--crc-border);background:var(--crc-bg-inset);padding:0.5rem 0.75rem;font-size:0.875rem;color:var(--crc-fg);outline:none}.ns-input:focus{border-color:var(--crc-focus)}`}</style>
      </div>
    </div>
  );
}
