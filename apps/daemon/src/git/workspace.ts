import type {
  WorkspaceChangesResponse,
  WorkspaceDirResponse,
  WorkspaceEntry,
  WorkspaceFileChange,
  WorkspaceFileDiffResponse,
  WorkspaceFileResponse,
} from "@renki/protocol";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { simpleGit } from "simple-git";

/**
 * Read-only views of a session's working tree for the clients' Changes and
 * Files panels: what the session changed relative to its base branch, and the
 * files themselves.
 *
 * Every path a client sends is resolved inside the tree and checked after
 * following symlinks, so `../` or a link pointing out of the worktree can't
 * read the rest of the host.
 */

/** Past this, a file's content or a diff is cut and flagged `truncated`. */
const MAX_BYTES = 512 * 1024;
/** How much of a file to sniff for a NUL byte when deciding it's binary. */
const SNIFF_BYTES = 8 * 1024;

export class WorkspacePathError extends Error {}

/**
 * Resolve a client-supplied relative path inside `root`, refusing anything
 * that lands outside it — before or after following symlinks — and the
 * repository's own `.git`.
 */
export async function safePath(root: string, rel: string): Promise<string> {
  if (isAbsolute(rel)) throw new WorkspacePathError("Path must be relative to the working tree.");
  const realRoot = await realpath(root);
  const target = resolve(realRoot, rel);
  const inside = (p: string) => p === realRoot || p.startsWith(realRoot + sep);
  if (!inside(target)) throw new WorkspacePathError("Path is outside the working tree.");
  const real = await realpath(target).catch(() => target); // a deleted file has no realpath; its lexical check stands
  if (!inside(real)) throw new WorkspacePathError("Path is outside the working tree.");
  if (relative(realRoot, real).split(sep)[0] === ".git") throw new WorkspacePathError("The .git directory isn't browsable.");
  return real;
}

async function isGitTree(dir: string): Promise<boolean> {
  try {
    return (await simpleGit(dir).raw(["rev-parse", "--is-inside-work-tree"])).trim() === "true";
  } catch {
    return false;
  }
}

/** The commit the branch left `baseBranch` at; the tree's own HEAD when there's no base to compare with. */
async function baseCommit(dir: string, baseBranch: string | null): Promise<string> {
  const git = simpleGit(dir);
  if (baseBranch) {
    try {
      return (await git.raw(["merge-base", baseBranch, "HEAD"])).trim();
    } catch {
      // The base branch is gone (deleted, renamed): fall back to HEAD, showing only uncommitted work.
    }
  }
  return (await git.raw(["rev-parse", "HEAD"])).trim();
}

/** Lines in a file, or null when it's binary (or unreadable). */
async function countLines(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    const read = await readHead(path, Math.min(info.size, MAX_BYTES));
    if (read.includes(0)) return null;
    const text = read.toString("utf8");
    if (text.length === 0) return 0;
    return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  } catch {
    return null;
  }
}

async function readHead(path: string, bytes: number): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * Everything the session changed since it branched off `baseBranch`: its
 * commits and its uncommitted and untracked work, as one list — the same
 * picture a reviewer would want before merging.
 */
export async function workspaceChanges(
  dir: string,
  baseBranch: string | null,
  branch: string | null,
): Promise<WorkspaceChangesResponse> {
  if (!(await isGitTree(dir))) return { available: false, base: null, branch: null, ahead: 0, files: [] };
  const git = simpleGit(dir);
  const base = await baseCommit(dir, baseBranch);

  const statuses = new Map<string, WorkspaceFileChange["status"]>();
  for (const line of (await git.raw(["diff", "--name-status", "--no-renames", base])).split("\n")) {
    const [code, ...rest] = line.split("\t");
    const path = rest.join("\t");
    if (!code || !path) continue;
    const c = code[0] as string;
    statuses.set(path, c === "A" || c === "D" || c === "T" ? c : "M");
  }

  const files: WorkspaceFileChange[] = [];
  for (const line of (await git.raw(["diff", "--numstat", "--no-renames", base])).split("\n")) {
    const [a, r, ...rest] = line.split("\t");
    const path = rest.join("\t");
    if (!path) continue;
    const binary = a === "-" && r === "-";
    files.push({
      path,
      status: statuses.get(path) ?? "M",
      added: binary ? null : Number(a),
      removed: binary ? null : Number(r),
    });
  }

  const untracked = (await git.raw(["ls-files", "--others", "--exclude-standard"])).split("\n").filter(Boolean);
  for (const path of untracked) {
    files.push({ path, status: "?", added: await countLines(resolve(dir, path)), removed: 0 });
  }
  files.sort((x, y) => x.path.localeCompare(y.path));

  const ahead = Number((await git.raw(["rev-list", "--count", `${base}..HEAD`])).trim()) || 0;
  return { available: true, base: baseBranch, branch, ahead, files };
}

/** One file's unified diff against the base. An untracked file is shown as all additions. */
export async function workspaceFileDiff(dir: string, baseBranch: string | null, rel: string): Promise<WorkspaceFileDiffResponse> {
  const abs = await safePath(dir, rel);
  const git = simpleGit(dir);
  const tracked = (await git.raw(["ls-files", "--", rel])).trim() !== "";
  const deletedInTree = !(await stat(abs).then(() => true, () => false));

  let patch: string;
  if (!tracked && !deletedInTree) {
    const lines = await countLines(abs);
    if (lines === null) patch = `Binary file ${rel}\n`;
    else {
      const text = (await readHead(abs, MAX_BYTES)).toString("utf8");
      const body = text.split("\n");
      if (text.endsWith("\n")) body.pop();
      patch = `--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${body.length} @@\n${body.map((l) => `+${l}`).join("\n")}\n`;
    }
  } else {
    patch = await git.raw(["diff", "--no-renames", await baseCommit(dir, baseBranch), "--", rel]);
  }
  const truncated = patch.length > MAX_BYTES;
  return { path: rel, patch: truncated ? patch.slice(0, MAX_BYTES) : patch, truncated };
}

/** One directory of the tree, directories first then files, each alphabetically. `.git` is left out. */
export async function listWorkspaceDir(root: string, rel: string): Promise<WorkspaceDirResponse> {
  const abs = rel ? await safePath(root, rel) : await realpath(root);
  const dirents = await readdir(abs, { withFileTypes: true });
  const entries: WorkspaceEntry[] = [];
  for (const d of dirents) {
    if (d.name === ".git") continue;
    const full = resolve(abs, d.name);
    let isDir = d.isDirectory();
    let size: number | null = null;
    if (d.isSymbolicLink() || d.isFile()) {
      const info = await stat(full).catch(() => null);
      if (!info) continue; // dangling link
      isDir = info.isDirectory();
      size = info.isFile() ? info.size : null;
    }
    entries.push({ name: d.name, type: isDir ? "dir" : "file", size: isDir ? null : size });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return { path: rel, entries };
}

/** A file's text, up to the size cap; null content for a binary file. */
export async function readWorkspaceFile(root: string, rel: string): Promise<WorkspaceFileResponse> {
  const abs = await safePath(root, rel);
  const info = await stat(abs);
  if (!info.isFile()) throw new WorkspacePathError("Not a file.");
  const sniff = await readHead(abs, Math.min(info.size, SNIFF_BYTES));
  if (sniff.includes(0)) return { path: rel, size: info.size, content: null, binary: true, truncated: false };
  const truncated = info.size > MAX_BYTES;
  const content = (await readHead(abs, Math.min(info.size, MAX_BYTES))).toString("utf8");
  return { path: rel, size: info.size, content, binary: false, truncated };
}
