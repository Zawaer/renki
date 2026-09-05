import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { GithubRepo } from "@crc/protocol";
import type { Config } from "./config.js";
import { logger } from "./logger.js";

const run = promisify(execFile);

/**
 * Cloning a repo from GitHub straight into the repos root, so a session can be
 * started on a project the host has never checked out — the thing that
 * otherwise needs an SSH session before CRC can see it at all.
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

/** Directory name a clone of `owner/name` lands in — the repo's own name, as git would. */
export function cloneDirName(repoRef: string): string {
  return repoRef.split("/")[1]!;
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
        : "The daemon's GitHub CLI isn't logged in — see SETUP.md § Pushing to GitHub.",
    };
  }
}

/**
 * The repos this login can see, most recently pushed first. Includes private
 * ones and anything from orgs the user belongs to, which is the point: the
 * list is here so you don't have to remember exact names.
 */
export async function listGithubRepos(limit = 200): Promise<GithubRepo[]> {
  const { stdout } = await run(
    "gh",
    ["repo", "list", "--limit", String(limit), "--json", "nameWithOwner,description,isPrivate,isFork,pushedAt,defaultBranchRef"],
    { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
  );
  const raw = JSON.parse(stdout) as Array<{
    nameWithOwner: string;
    description: string | null;
    isPrivate: boolean;
    isFork: boolean;
    pushedAt: string | null;
    defaultBranchRef: { name: string } | null;
  }>;
  return raw.map((r) => ({
    fullName: r.nameWithOwner,
    name: r.nameWithOwner.split("/")[1] ?? r.nameWithOwner,
    description: r.description,
    isPrivate: r.isPrivate,
    isFork: r.isFork,
    pushedAt: r.pushedAt,
    defaultBranch: r.defaultBranchRef?.name ?? null,
  }));
}

export type CloneOutcome = { ok: true; dirName: string; alreadyPresent: boolean } | { ok: false; message: string };

/**
 * Clone `owner/name` into the repos root. Idempotent-ish: an existing
 * directory of that name is reported back rather than overwritten, since it's
 * far more likely to be the same project already cloned than something to
 * clobber. Shallow clones are deliberately NOT used — sessions branch, commit
 * and merge against real history.
 */
export async function cloneGithubRepo(config: Config, input: string): Promise<CloneOutcome> {
  const repoRef = parseRepoRef(input);
  if (!repoRef) return { ok: false, message: `"${input}" isn't a GitHub repo — use owner/name or a github.com URL.` };

  const dirName = cloneDirName(repoRef);
  const target = resolve(config.reposRoot, dirName);
  // Exact parent check, not a prefix one: "/repos-elsewhere" also starts with "/repos".
  if (dirname(target) !== resolve(config.reposRoot)) return { ok: false, message: "Refusing to clone outside the repos root." };
  if (existsSync(target)) {
    logger.info("clone skipped; directory already exists", { repoRef, target });
    return { ok: true, dirName, alreadyPresent: true };
  }

  try {
    logger.info("cloning from github", { repoRef, target });
    await run("git", ["clone", `https://github.com/${repoRef}.git`, target], { timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, dirName, alreadyPresent: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("clone failed", { repoRef, err: msg });
    if (/could not read Username|Authentication failed|403/i.test(msg))
      return { ok: false, message: "GitHub refused the clone — the daemon's GitHub login can't see that repo." };
    if (/not found|Repository not found|404/i.test(msg)) return { ok: false, message: `Couldn't find ${repoRef} on GitHub.` };
    return { ok: false, message: `Clone failed: ${msg.split("\n")[0]}` };
  }
}
