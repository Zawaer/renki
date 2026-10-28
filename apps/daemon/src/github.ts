import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { GithubRepo } from "@renki/protocol";
import type { Config } from "./config.js";
import { originRepo } from "./repos.js";
import { logger } from "./logger.js";

const run = promisify(execFile);

/**
 * Cloning a repo from GitHub straight into the repos root, so a session can be
 * started on a project the host has never checked out — the thing that
 * otherwise needs an SSH session before Renki can see it at all.
 *
 * Authentication is whatever `gh` has (see SETUP.md § Pushing to GitHub); this
 * module never handles a token itself. Every command runs through execFile
 * with an argument array — never a shell string — and the repo name is
 * validated before it gets anywhere near that, since it arrives over the wire.
 */

/** `owner/name`, the only shape we accept. GitHub's own rules, no path traversal, no options. */
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

/**
 * Pull `owner/name` out of whatever the user pasted: a bare slug, an https
 * URL, an ssh remote, with or without a trailing `.git` or slash. Returns null
 * when it isn't recognisably a GitHub repo.
 */
export function parseRepoRef(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  s = s.replace(/^git\+/, "");
  s = s.replace(/^https?:\/\/(www\.)?github\.com\//i, "");
  s = s.replace(/^git@github\.com:/i, "");
  s = s.replace(/^github\.com\//i, "");
  s = s.replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!REPO_RE.test(s)) return null;
  // "." and ".." satisfy the character class but would resolve outside the
  // repos root once used as a directory name.
  const name = s.split("/")[1]!;
  return name === "." || name === ".." ? null : s;
}

/**
 * Directory names a clone of `owner/name` may land in: the repo's own name, as
 * git would, then `owner-name` for when that one belongs to a different repo
 * (two forks, or an org copy, share a name).
 */
export function cloneDirNames(repoRef: string): [string, string] {
  const [owner, name] = repoRef.split("/") as [string, string];
  return [name, `${owner}-${name}`];
}

export type GithubStatus = { available: boolean; login: string | null; reason: string | null };

/** Is `gh` installed and logged in? Drives whether clients offer the browse-and-clone flow at all. */
export async function githubStatus(): Promise<GithubStatus> {
  try {
    const { stdout } = await run("gh", ["api", "user", "--jq", ".login"], { timeout: 15_000 });
    const login = stdout.trim();
    return { available: Boolean(login), login: login || null, reason: login ? null : "gh returned no user" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const missing = /ENOENT/.test(msg);
    return {
      available: false,
      login: null,
      reason: missing
        ? "The GitHub CLI isn't installed in the daemon."
        : "The daemon's GitHub CLI isn't logged in. See SETUP.md § Pushing to GitHub.",
    };
  }
}

/**
 * The repos this login can see, most recently pushed first: its own, ones
 * it collaborates on, and its orgs'. Private ones too. The list is here so you
 * don't have to remember exact names. (`gh repo list` was used before, but it
 * only returns the login's own repos, so org and shared ones were missing.)
 */
export async function listGithubRepos(limit = 200): Promise<GithubRepo[]> {
  const { stdout } = await run(
    "gh",
    [
      "api",
      "--paginate",
      "user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
      "--jq",
      ".[] | {full_name, name, description, private, fork, pushed_at, default_branch}",
    ],
    { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
  );
  return stdout
    .split("\n")
    .filter((l) => l.trim())
    .slice(0, limit)
    .map((l) => {
      const r = JSON.parse(l) as {
        full_name: string;
        name: string;
        description: string | null;
        private: boolean;
        fork: boolean;
        pushed_at: string | null;
        default_branch: string | null;
      };
      return {
        fullName: r.full_name,
        name: r.name,
        description: r.description,
        isPrivate: r.private,
        isFork: r.fork,
        pushedAt: r.pushed_at,
        defaultBranch: r.default_branch,
      };
    });
}

export type CloneOutcome = { ok: true; dirName: string; alreadyPresent: boolean } | { ok: false; message: string };

/**
 * Clone `owner/name` into the repos root, or hand back the checkout already
 * there. A directory counts as that checkout only when its `origin` is that
 * repo: a folder of the same name from another owner, a renamed repo or no
 * GitHub remote at all is left alone, and the clone goes to `owner-name`
 * instead. Shallow clones are deliberately NOT used — sessions branch, commit
 * and merge against real history.
 */
export async function cloneGithubRepo(config: Config, input: string): Promise<CloneOutcome> {
  const repoRef = parseRepoRef(input);
  if (!repoRef) return { ok: false, message: `"${input}" isn't a GitHub repo. Use owner/name or a github.com URL.` };

  let dirName: string | null = null;
  for (const candidate of cloneDirNames(repoRef)) {
    const path = resolve(config.reposRoot, candidate);
    // Exact parent check, not a prefix one: "/repos-elsewhere" also starts with "/repos".
    if (dirname(path) !== resolve(config.reposRoot)) return { ok: false, message: "Refusing to clone outside the repos root." };
    if (!existsSync(path)) {
      dirName = candidate;
      break;
    }
    if ((await originRepo(path))?.toLowerCase() === repoRef.toLowerCase()) {
      logger.info("clone skipped; already checked out", { repoRef, path });
      return { ok: true, dirName: candidate, alreadyPresent: true };
    }
  }
  if (!dirName) return { ok: false, message: `Couldn't clone ${repoRef}: folders with its name already hold other repos.` };
  const target = resolve(config.reposRoot, dirName);

  try {
    logger.info("cloning from github", { repoRef, target });
    await run("git", ["clone", `https://github.com/${repoRef}.git`, target], { timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, dirName, alreadyPresent: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("clone failed", { repoRef, err: msg });
    if (/could not read Username|Authentication failed|403/i.test(msg))
      return { ok: false, message: "GitHub refused the clone: the daemon's GitHub login can't see that repo." };
    if (/not found|Repository not found|404/i.test(msg)) return { ok: false, message: `Couldn't find ${repoRef} on GitHub.` };
    return { ok: false, message: `Clone failed: ${msg.split("\n")[0]}` };
  }
}
