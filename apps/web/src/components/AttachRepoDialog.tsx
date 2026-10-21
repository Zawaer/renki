import type { GithubRepo, Repo, Session } from "@renki/protocol";
import { useEffect, useState } from "react";
import { useClient } from "../lib/client.js";
import { GithubBrowser } from "./NewSessionDialog.js";
import { Button, Select } from "./ui.js";

/** Sentinel that opens the GitHub browser instead of selecting anything. */
const FROM_GITHUB = "__github";

/**
 * Move a repo-less chat into a repo — usually one the chat just made on
 * GitHub. Picking from GitHub hands the daemon the name and it clones first.
 */
export function AttachRepoDialog({
  session,
  onClose,
  onAttached,
}: {
  session: Session;
  onClose: () => void;
  onAttached: (session: Session) => void;
}) {
  const { rest } = useClient();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repoId, setRepoId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [gh, setGh] = useState<{ available: boolean; reason: string | null; repos: GithubRepo[] } | null>(null);
  const [ghQuery, setGhQuery] = useState("");
  const [cloning, setCloning] = useState<string | null>(null);

  useEffect(() => {
    rest
      .listRepos()
      .then((r) => {
        setRepos(r);
        if (r[0]) setRepoId(r[0].id);
      })
      .catch((e) => setError(String(e)));
  }, [rest]);

  function openGithubBrowser() {
    setBrowsing(true);
    setError(null);
    if (gh) return;
    rest
      .listGithubRepos()
      .then((res) => setGh({ available: res.available, reason: res.reason, repos: res.repos }))
      .catch(() => setGh({ available: false, reason: "Couldn't reach the daemon.", repos: [] }));
  }

  async function attach(target: { repoId: string } | { github: string }) {
    setBusy(true);
    setError(null);
    if ("github" in target) setCloning(target.github);
    try {
      onAttached(await rest.attachRepo(session.id, target));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't move this chat into the repo.");
      setBusy(false);
    } finally {
      setCloning(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        className="renki-enter w-full max-w-md space-y-4 rounded-2xl border border-(--renki-border) bg-(--renki-surface) p-6 shadow-(--renki-shadow-lg)"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-(--renki-fg)">Move into a repo</h2>
          <p className="mt-0.5 text-xs text-(--renki-fg-muted)">
            The chat carries on in its own branch and worktree of the repo, with the conversation intact. Files made so far stay
            where they are.
          </p>
        </div>

        {browsing ? (
          <GithubBrowser
            gh={gh}
            query={ghQuery}
            onQuery={setGhQuery}
            cloning={cloning}
            alreadyCloned={new Set(repos.map((r) => r.name.toLowerCase()))}
            onPick={(full) => void attach({ github: full })}
            onCancel={() => setBrowsing(false)}
          />
        ) : (
          <div className="space-y-1">
            <span className="block text-xs font-medium text-(--renki-fg-muted)">Repository</span>
            <Select
              value={repoId}
              onChange={(id) => (id === FROM_GITHUB ? openGithubBrowser() : setRepoId(id))}
              options={[
                ...repos.map((r) => ({ value: r.id, label: r.name, description: r.defaultBranch })),
                { value: FROM_GITHUB, label: "From GitHub…", description: "A repo this host hasn't checked out yet" },
              ]}
            />
          </div>
        )}

        {error && <p className="rounded-lg bg-(--renki-danger)/10 px-3 py-2 text-sm text-(--renki-danger)">{error}</p>}

        {!browsing && (
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy || !repoId} onClick={() => void attach({ repoId })}>
              {busy ? "Moving…" : "Move"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
