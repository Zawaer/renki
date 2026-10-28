import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, lstatSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { MacManifestEntry } from "@renki/protocol";

/**
 * Build jobs on the Mac (see mac/tools.ts `mac_build`), daemon side: which
 * files of a session's working tree the Mac may fetch, and where the job's
 * artifacts land on this machine.
 *
 * The mirror is the session's working tree as git sees it: tracked files plus
 * untracked ones that aren't ignored, so node_modules and build outputs stay
 * out. Only regular files are sent; symlinks are skipped, so a link can't make
 * this daemon hand out something outside the tree.
 */

const run = promisify(execFile);
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TREE_BYTES = 500 * 1024 * 1024;
// Room for a build to wait its turn on the Mac (one at a time, up to 60 min each) and then run.
const JOB_TTL_MS = 4 * 60 * 60_000;
const ARTIFACT_KEEP_MS = 3 * 24 * 60 * 60_000;
export const MAX_ARTIFACT_BYTES = 600 * 1024 * 1024;
export const MAX_ARTIFACTS_PER_JOB = 12;

export class ManifestError extends Error {}

/** The working tree as a manifest. Throws ManifestError with a message for Claude. */
export async function buildManifest(cwd: string): Promise<MacManifestEntry[]> {
  let out: string;
  try {
    ({ stdout: out } = await run("git", ["-C", cwd, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { maxBuffer: 64 * 1024 * 1024 }));
  } catch {
    throw new ManifestError("This session's folder isn't a git repository, so it can't be mirrored to the Mac.");
  }
  const seen = new Set<string>();
  const entries: MacManifestEntry[] = [];
  let total = 0;
  for (const p of out.split("\0")) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    const full = join(cwd, p);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue; // deleted but not yet staged
    }
    if (!st.isFile()) continue; // symlinks, submodules
    if (st.size > MAX_FILE_BYTES) throw new ManifestError(`${p} is over 50 MB; large files can't be mirrored to the Mac.`);
    total += st.size;
    if (total > MAX_TREE_BYTES) throw new ManifestError("The working tree is over 500 MB; too big to mirror to the Mac.");
    entries.push({ p, h: await sha1(full), x: (st.mode & 0o111) !== 0 });
  }
  return entries;
}

function sha1(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const h = createHash("sha1");
    createReadStream(path)
      .on("data", (d) => h.update(d))
      .on("error", reject)
      .on("end", () => resolvePromise(h.digest("hex")));
  });
}

type Job = { cwd: string; paths: Set<string>; artifactDir: string; artifacts: number; expires: number };

export class MacJobs {
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly artifactsRoot: string) {}

  open(cwd: string, sessionId: string, manifest: MacManifestEntry[]): { id: string; artifactDir: string } {
    this.sweep();
    const id = randomBytes(18).toString("base64url");
    const artifactDir = join(this.artifactsRoot, sessionId.replace(/[^\w-]/g, "_"), id);
    this.jobs.set(id, { cwd: resolve(cwd), paths: new Set(manifest.map((e) => e.p)), artifactDir, artifacts: 0, expires: Date.now() + JOB_TTL_MS });
    return { id, artifactDir };
  }

  close(id: string): void {
    this.jobs.delete(id);
  }

  isOpen(id: string): boolean {
    return this.live(id) !== null;
  }

  /** The absolute path of a file the Mac may fetch for this job, or null. */
  fileFor(id: string, rel: string): string | null {
    const job = this.live(id);
    if (!job || !job.paths.has(rel)) return null;
    const full = resolve(job.cwd, rel);
    if (!full.startsWith(job.cwd + sep)) return null;
    try {
      return lstatSync(full).isFile() ? full : null;
    } catch {
      return null;
    }
  }

  /** Where an uploaded artifact goes, or null when the job is unknown, full, or the name is odd. */
  artifactPath(id: string, name: string): string | null {
    const job = this.live(id);
    if (!job || !/^[\w][\w.-]{0,120}$/.test(name) || job.artifacts >= MAX_ARTIFACTS_PER_JOB) return null;
    job.artifacts++;
    mkdirSync(job.artifactDir, { recursive: true });
    return join(job.artifactDir, name);
  }

  private live(id: string): Job | null {
    const job = this.jobs.get(id);
    return job && job.expires > Date.now() ? job : null;
  }

  /** Forget expired jobs and delete artifacts older than a few days. */
  private sweep(): void {
    const now = Date.now();
    for (const [id, j] of this.jobs) if (j.expires < now) this.jobs.delete(id);
    let sessions: string[] = [];
    try {
      sessions = readdirSync(this.artifactsRoot);
    } catch {
      return;
    }
    for (const s of sessions) {
      const dir = join(this.artifactsRoot, s);
      for (const job of safeList(dir)) {
        const p = join(dir, job);
        try {
          if (now - statSync(p).mtimeMs > ARTIFACT_KEEP_MS) rmSync(p, { recursive: true, force: true });
        } catch {
          /* raced with another sweep */
        }
      }
      if (safeList(dir).length === 0) rmSync(dir, { recursive: true, force: true });
    }
  }
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
