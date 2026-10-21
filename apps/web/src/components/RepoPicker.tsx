import { filterRepoChoices, repoChoices, type RepoChoice } from "@renki/client-core";
import type { GithubReposResponse, Repo } from "@renki/protocol";
import { useEffect, useMemo, useState } from "react";
import { useClient } from "../lib/client.js";
import { PickerButton } from "./SessionView.js";

/** Your GitHub repos and the host's checkouts, loaded once per picker. Null until each arrives. */
export function useRepoChoices(): { choices: RepoChoice[] | null; github: GithubReposResponse | null } {
  const { rest } = useClient();
  const [local, setLocal] = useState<Repo[] | null>(null);
  const [github, setGithub] = useState<GithubReposResponse | null>(null);
  useEffect(() => {
    rest.listRepos().then(setLocal).catch(() => setLocal([]));
    rest
      .listGithubRepos()
      .then(setGithub)
      .catch(() => setGithub({ available: false, reason: "Couldn't reach the daemon.", login: null, repos: [] }));
  }, [rest]);
  // Local repos show as soon as they're in; GitHub's list (a few seconds via gh) fills in after.
  const choices = useMemo(() => (local ? repoChoices(local, github?.available ? github.repos : null) : null), [local, github]);
  return { choices, github };
}

/** "Zawaer/about-me" → "about-me": the owner is the same on nearly every row, so the chip leaves it off. */
function shortLabel(choice: RepoChoice): string {
  return choice.label.split("/").pop() ?? choice.label;
}

/**
 * The composer's repo chip: "No repo" until you pick one. Lists your GitHub
 * repos directly — one the host hasn't checked out yet is cloned when the
 * session starts — and accepts a typed owner/name the list didn't reach.
 */
export function RepoPicker({
  choices,
  github,
  value,
  onChange,
  disabled,
}: ReturnType<typeof useRepoChoices> & {
  value: RepoChoice | null;
  onChange: (choice: RepoChoice | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const matches = useMemo(() => filterRepoChoices(choices ?? [], query), [choices, query]);
  const typed = query.trim();
  const typedRef =
    /^[\w.-]+\/[\w.-]+$/.test(typed) && !(choices ?? []).some((c) => c.fullName?.toLowerCase() === typed.toLowerCase()) ? typed : null;

  function pick(choice: RepoChoice | null) {
    onChange(choice);
    setOpen(false);
    setQuery("");
  }

  return (
    <div className="relative">
      <PickerButton
        label={
          <span className="flex items-center gap-1">
            <span className={`codicon ${value ? "codicon-repo" : "codicon-comment"} text-[12px]`} />
            {value ? shortLabel(value) : "No repo"}
          </span>
        }
        open={open}
        onToggle={() => !disabled && setOpen((v) => !v)}
      />
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="renki-enter absolute bottom-full left-0 z-50 mb-2 w-80 rounded-xl bg-(--renki-surface) p-1 text-xs shadow-(--renki-shadow-lg)">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
                if (e.key === "Enter") {
                  e.preventDefault();
                  const first = typedRef ? typedChoice(typedRef) : matches[0];
                  if (first) pick(first);
                }
              }}
              placeholder="Search your repos, or type owner/name"
              spellCheck={false}
              className="renki-input mb-1"
            />
            <div className="max-h-72 overflow-y-auto">
              {!query && (
                <Row
                  icon="codicon-comment"
                  label="No repo"
                  description="Just chat, in a folder of its own"
                  selected={!value}
                  onClick={() => pick(null)}
                />
              )}
              {typedRef && <Row icon="codicon-repo-clone" label={typedRef} description="Clone by name" onClick={() => pick(typedChoice(typedRef))} />}
              {matches.map((c) => (
                <Row
                  key={c.key}
                  icon={c.isPrivate ? "codicon-lock-small" : "codicon-repo"}
                  label={c.label}
                  description={c.description}
                  hint={c.local ? null : "clones on start"}
                  selected={value?.key === c.key}
                  onClick={() => pick(c)}
                />
              ))}
              {(!choices || !github) && <div className="px-3 py-2 text-(--renki-fg-muted)">Loading your GitHub repos…</div>}
              {github && !github.available && (
                <div className="px-3 py-2 text-(--renki-fg-muted)">{github.reason ?? "The daemon has no GitHub login."} Showing this host's checkouts.</div>
              )}
              {choices && github && matches.length === 0 && !typedRef && query && (
                <div className="px-3 py-2 text-(--renki-fg-muted)">Nothing matches. Type an exact owner/name to clone it.</div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function typedChoice(fullName: string): RepoChoice {
  return { key: `gh:${fullName}`, label: fullName, description: null, isPrivate: false, fullName, local: null };
}

function Row({
  icon,
  label,
  description,
  hint,
  selected,
  onClick,
}: {
  icon: string;
  label: string;
  description?: string | null;
  hint?: string | null;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-(--renki-hover)">
      <span className={`codicon ${icon} shrink-0 text-[13px] text-(--renki-fg-muted)`} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-(--renki-fg)">{label}</span>
        {description && <span className="block truncate text-(--renki-fg-muted)">{description}</span>}
      </span>
      {hint && <span className="shrink-0 text-[11px] text-(--renki-fg-muted)">{hint}</span>}
      {selected && <span className="codicon codicon-check shrink-0 text-[12px] text-(--renki-accent)" />}
    </button>
  );
}
