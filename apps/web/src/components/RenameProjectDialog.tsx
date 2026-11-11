import { useState } from "react";
import { useClient } from "../lib/client.js";
import { Button } from "./ui.js";

/**
 * Rename a project: Renki's copy of the repo, and the name its chats are listed under. The chats
 * carry on as they were. The GitHub repo keeps its name (rename it there if you want; Renki follows
 * GitHub's redirect).
 */
export function RenameProjectDialog({
  repoId,
  name,
  onClose,
  onRenamed,
}: {
  repoId: string;
  name: string;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const { rest } = useClient();
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = value.trim();

  async function rename() {
    setBusy(true);
    setError(null);
    try {
      await rest.renameRepo(repoId, next);
      onRenamed();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't rename the project.");
      setBusy(false);
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
          <h2 className="text-lg font-semibold tracking-tight text-(--renki-fg)">Rename project</h2>
          <p className="mt-0.5 text-xs text-(--renki-fg-muted)">
            Renames Renki's copy of {name}. Its chats carry on where they are, and homelab access comes along. The GitHub repo
            keeps its name, and Mac build jobs stay listed under {name} until you rename them on the Mac.
          </p>
        </div>

        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && next && next !== name && !busy) void rename();
          }}
          spellCheck={false}
          className="w-full rounded-lg border border-(--renki-border) bg-(--renki-bg-inset) px-3 py-2 font-mono text-sm text-(--renki-fg) outline-none focus:border-(--renki-accent)"
        />

        {error && <p className="rounded-lg bg-(--renki-danger)/10 px-3 py-2 text-sm text-(--renki-danger)">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !next || next === name} onClick={() => void rename()}>
            {busy ? "Renaming…" : "Rename"}
          </Button>
        </div>
      </div>
    </div>
  );
}
