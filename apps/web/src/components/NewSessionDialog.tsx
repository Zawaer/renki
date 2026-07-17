import type { Repo, Session } from "@crc/protocol";
import { useEffect, useState } from "react";
import { useClient } from "../lib/client.js";
import { Button } from "./ui.js";

/** Create a session: pick a repo, base branch, optional new-branch name + title. */
export function NewSessionDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (session: Session) => void;
}) {
  const { rest } = useClient();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repoId, setRepoId] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    if (repo) setBaseBranch(repo.defaultBranch);
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const session = await rest.createSession({
        repoId,
        baseBranch,
        newBranch: newBranch.trim() || undefined,
        title: title.trim() || undefined,
      });
      onCreated(session);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create session.");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md space-y-3 rounded-xl border border-neutral-800 bg-neutral-900 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold">New session</h2>

        <label className="block space-y-1">
          <span className="text-xs text-neutral-400">Repository</span>
          <select value={repoId} onChange={(e) => pickRepo(e.target.value)} className="ns-input">
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block space-y-1">
          <span className="text-xs text-neutral-400">Base branch</span>
          <input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} className="ns-input" />
        </label>

        <label className="block space-y-1">
          <span className="text-xs text-neutral-400">New branch (optional)</span>
          <input
            value={newBranch}
            onChange={(e) => setNewBranch(e.target.value)}
            placeholder="auto: crc/xxxxxx"
            className="ns-input"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-xs text-neutral-400">Title (optional)</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} className="ns-input" />
        </label>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !repoId || !baseBranch} onClick={create}>
            {busy ? "Creating…" : "Create"}
          </Button>
        </div>

        <style>{`.ns-input{width:100%;border-radius:0.5rem;border:1px solid #262626;background:#0b0d10;padding:0.5rem 0.75rem;font-size:0.875rem;color:#e5e7eb;outline:none}.ns-input:focus{border-color:#4f46e5}`}</style>
      </div>
    </div>
  );
}
