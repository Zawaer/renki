import type { GithubRepo, Repo } from "@renki/protocol";
import type { RestClient } from "./rest.js";

/**
 * One row of the repo picker. The list is your GitHub repos, not the folders
 * the host happens to have checked out: `local` is the checkout when there is
 * one, and a repo without one is cloned the first time a session starts on it
 * (see resolveRepoChoice). Local repos that aren't on GitHub (or that the
 * daemon's login can't see) are listed too, after the rest.
 */
export type RepoChoice = {
  key: string;
  /** What the row says: owner/name for a GitHub repo, the folder name for a local-only one. */
  label: string;
  description: string | null;
  isPrivate: boolean;
  /** owner/name, when it's on GitHub. */
  fullName: string | null;
  local: Repo | null;
};

/** GitHub's order (most recently pushed first), each matched to its checkout by name, the way clones are named. */
export function repoChoices(local: Repo[], github: GithubRepo[] | null): RepoChoice[] {
  const byName = new Map(local.map((r) => [r.name.toLowerCase(), r]));
  const matched = new Set<Repo>();
  const out: RepoChoice[] = (github ?? []).map((g) => {
    const repo = byName.get(g.name.toLowerCase()) ?? null;
    if (repo) matched.add(repo);
    return { key: `gh:${g.fullName}`, label: g.fullName, description: g.description, isPrivate: g.isPrivate, fullName: g.fullName, local: repo };
  });
  for (const r of local) {
    if (!matched.has(r)) out.push({ key: `local:${r.id}`, label: r.name, description: null, isPrivate: false, fullName: null, local: r });
  }
  return out;
}

/** Rows matching a search: label or description, case-insensitive. */
export function filterRepoChoices(choices: RepoChoice[], query: string): RepoChoice[] {
  const q = query.trim().toLowerCase();
  if (!q) return choices;
  return choices.filter((c) => c.label.toLowerCase().includes(q) || (c.description ?? "").toLowerCase().includes(q));
}

/** The checkout to start a session on: the one the row has, or a fresh clone. Throws with the daemon's message if cloning fails. */
export async function resolveRepoChoice(rest: RestClient, choice: RepoChoice): Promise<Repo> {
  if (choice.local) return choice.local;
  const res = await rest.cloneGithubRepo(choice.fullName!);
  if (!res.ok || !res.repo) throw new Error(res.message ?? `Couldn't clone ${choice.fullName}.`);
  return res.repo;
}
