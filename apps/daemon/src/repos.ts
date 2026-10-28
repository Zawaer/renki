import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { Repo } from "@renki/protocol";
import { simpleGit } from "simple-git";
import type { Config } from "./config.js";
import { parseRepoRef } from "./github.js";
import { logger } from "./logger.js";

/**
 * Discover git repositories directly under the configured root. We only look
 * one level deep on purpose: the root is "my folder of GitHub projects", and
 * each immediate child that contains a `.git` is a repo. Nested/monorepo
 * sub-packages are out of scope for v1.
 */
export async function scanRepos(config: Config): Promise<Repo[]> {
  const root = config.reposRoot;
  if (!existsSync(root)) {
    logger.warn("repos root does not exist", { root });
    return [];
  }

  const entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  const repos: Repo[] = [];

  for (const entry of entries) {
    const path = resolve(root, entry.name);
    // A worktree checkout has `.git` as a file, a normal clone as a dir — accept both.
    if (!existsSync(resolve(path, ".git"))) continue;

    repos.push({
      id: slug(entry.name),
      name: entry.name,
      path,
      defaultBranch: await detectDefaultBranch(path),
      remote: await originRepo(path),
    });
  }

  repos.sort((a, b) => a.name.localeCompare(b.name));
  logger.info("scanned repos", { root, count: repos.length });
  return repos;
}

/** Resolve a single repo by its id, or null if it's no longer present. */
export async function findRepo(config: Config, repoId: string): Promise<Repo | null> {
  const repos = await scanRepos(config);
  return repos.find((r) => r.id === repoId) ?? null;
}

/**
 * Best-effort default branch: prefer the remote HEAD (origin/HEAD -> main|master),
 * fall back to whatever HEAD currently points at, then "main".
 */
async function detectDefaultBranch(repoPath: string): Promise<string> {
  const git = simpleGit(repoPath);
  try {
    const ref = await git.raw(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    const name = ref.trim().replace(/^origin\//, "");
    if (name) return name;
  } catch {
    /* no remote HEAD — fall through */
  }
  try {
    const head = (await git.raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (head && head !== "HEAD") return head;
  } catch {
    /* detached or empty repo */
  }
  return "main";
}

/** owner/name of a checkout's `origin`, when that's on GitHub. What the picker matches it to GitHub by. */
export async function originRepo(repoPath: string): Promise<string | null> {
  // execFile, not simple-git: its failure path (no origin exits 1) waits on a timer.
  try {
    const { stdout } = await promisify(execFile)("git", ["-C", repoPath, "config", "--get", "remote.origin.url"]);
    return parseRepoRef(stdout);
  } catch {
    return null; // no origin
  }
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
