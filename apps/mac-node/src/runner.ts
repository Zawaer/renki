import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { MacArgs } from "@renki/protocol";
import type { Result } from "./adb.js";
import { capText } from "./adb.js";
import type { Config } from "./config.js";
import { signApk } from "./signing.js";

/**
 * Build jobs (verb `run`), agent side. The agent never runs a build itself:
 * every step happens in renki-runner.mjs inside the build VM's container
 * (./vm.ts). The agent only moves bytes:
 *
 *   containment probe -> diff -> fetch changed files -> apply -> run ->
 *   export artifacts -> (sign APKs with the user's key, here) -> upload to the
 *   homelab -> (install the APK with adb)
 *
 * Nothing comes back from the container except through its stdout, so a
 * build can't trick this process (the real user) into reading a file of yours.
 */

/** Where jobs run: the build VM (./vm.ts), or a fake in tests. */
export type BuildHost = {
  wrapper: RunWrapper;
  /** Bring it up; null when ready, else why not. */
  ensure: () => Promise<string | null>;
  stop: () => Promise<void>;
  /** The address the build host would use to reach the Mac's own localhost. */
  macAddress: string;
};

export type WrapperResult = { code: number; stdout: Buffer; stderr: string };
/**
 * Run renki-runner.mjs where builds run. `onOutput` streams stdout+stderr instead of collecting stdout.
 * With `signal`, its stdin stays open until the signal fires; closing it stops the job (see runner-wrapper.ts `run`).
 */
export type RunWrapper = (
  args: string[],
  opts?: { stdin?: Buffer; onOutput?: (chunk: Buffer) => void; stdoutTo?: string; signal?: AbortSignal },
) => Promise<WrapperResult>;

export type Daemon = {
  /** POST the paths, get the framed bundle back. */
  fetchFiles: (jobId: string, paths: string[]) => Promise<Buffer>;
  /** PUT one file; returns where the homelab stored it. */
  upload: (jobId: string, name: string, file: string) => Promise<string>;
  /** host and port the runner must NOT be able to reach (checked by the probe). */
  host: string;
  port: number;
};

const MAX_LOG = 20 * 1024 * 1024;

const STOPPED: Result = { ok: false, text: "Stopped on the Mac: Renki no longer waits for this build." };

/** Where a job has got to, for the session watching it: a phase, and the build's latest log line. */
export type Progress = (phase: string, detail?: string) => void;

export class Runner {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly config: Config,
    private readonly host: BuildHost,
    private readonly daemon: Daemon,
    private readonly install: (apk: string, serial: string | undefined) => Promise<Result>,
    /** Sign an APK in place with the key `props` names; returns its certificate's SHA-256. */
    private readonly sign: (apk: string, props: string) => Promise<string> = (apk, props) => signApk(apk, props, config.apksigner),
  ) {}

  /** One job at a time per project: they share a mirror. */
  run(args: MacArgs<"run">, progress: Progress = () => {}, signal?: AbortSignal): Promise<Result> {
    const prev = this.locks.get(args.project);
    if (prev) progress("Waiting for another build of this project");
    const next = (prev ?? Promise.resolve()).then(() => this.runLocked(args, progress, signal)).catch((err) => ({ ok: false, text: `Failed on the Mac: ${err instanceof Error ? err.message : String(err)}` }));
    this.locks.set(args.project, next);
    return next;
  }

  /** Lending switched off: stop the build VM and everything in it. */
  stop(): Promise<void> {
    return this.host.stop();
  }

  private get wrapper(): RunWrapper {
    return this.host.wrapper;
  }

  private async runLocked(args: MacArgs<"run">, progress: Progress, signal?: AbortSignal): Promise<Result> {
    if (signal?.aborted) return STOPPED;
    const job = this.config.jobs[args.project]?.[args.job];
    if (!job) return { ok: false, text: `This Mac has no job "${args.job}" for ${args.project}.` };
    if (args.install && !job.installApk) return { ok: false, text: `Job "${args.job}" doesn't produce an APK to install.` };

    progress("Starting the build VM");
    const down = await this.host.ensure();
    if (down) return { ok: false, text: down };
    progress("Checking the sandbox");
    const probe = await this.checkContainment();
    if (probe) return { ok: false, text: probe };

    const started = Date.now();
    const p = args.project;

    // 1. Bring the mirror in line with the session's working tree.
    progress("Syncing files");
    const manifestJson = Buffer.from(JSON.stringify(args.manifest));
    const diff = await this.wrapper(["diff", p], { stdin: manifestJson });
    if (diff.code !== 0) return { ok: false, text: `Syncing failed on the Mac: ${diff.stderr.trim()}` };
    const need = JSON.parse(diff.stdout.toString()) as string[];
    progress("Syncing files", `${need.length} changed of ${args.manifest.length}`);
    const bundle = need.length ? await this.daemon.fetchFiles(args.jobId, need) : Buffer.alloc(0);
    const applied = await this.wrapper(["apply", p], { stdin: Buffer.concat([manifestJson, Buffer.from("\n"), bundle]) });
    if (applied.code !== 0) return { ok: false, text: `Syncing failed on the Mac: ${applied.stderr.trim()}` };

    // 2. Run the job's own command, as the runner.
    progress("Building");
    const log: Buffer[] = [];
    let logBytes = 0;
    const lastLine = new LastLine();
    if (signal?.aborted) return STOPPED;
    const res = await this.wrapper(["run", p, job.cwd ?? ".", String(job.timeoutMinutes * 60), job.command], {
      signal,
      onOutput: (d) => {
        if (logBytes < MAX_LOG) log.push(d);
        logBytes += d.length;
        const line = lastLine.push(d);
        if (line) progress("Building", line);
      },
    });
    if (signal?.aborted) return STOPPED;
    const logText = Buffer.concat(log).toString();
    const took = Math.round((Date.now() - started) / 1000);

    const work = await mkdtemp(join(tmpdir(), "renki-job-"));
    try {
      const lines: string[] = [
        `Job ${args.job} on ${this.config.name}: ${res.code === 0 ? "succeeded" : `failed (exit ${res.code})`} in ${took}s. Synced ${need.length} changed file(s) of ${args.manifest.length}.`,
      ];

      // 3. Bring back the full log, and on success the artifacts.
      progress("Uploading artifacts");
      const logFile = join(work, "build.log");
      await new Promise<void>((resolve, reject) => {
        const w = createWriteStream(logFile, { mode: 0o600 });
        w.on("error", reject).on("finish", resolve);
        w.end(logText);
      });
      lines.push(`Full log on this machine: ${await this.daemon.upload(args.jobId, "build.log", logFile).catch((e) => `(upload failed: ${e})`)}`);

      let apkLocal: string | null = null;
      if (res.code === 0) {
        const wanted = [...new Set([...job.artifacts, ...(args.install && job.installApk ? [job.installApk] : [])])];
        const used = new Set<string>();
        for (const rel of wanted) {
          let name = basename(rel).replace(/[^\w.-]/g, "_");
          while (used.has(name)) name = `x-${name}`;
          used.add(name);
          const local = join(work, name);
          const ex = await this.wrapper(["export", p, rel], { stdoutTo: local });
          if (ex.code !== 0) {
            lines.push(`Artifact ${rel}: ${ex.stderr.trim()}`);
            continue;
          }
          if (job.signApks && rel.endsWith(".apk")) {
            progress("Signing with your key");
            const signed = await this.sign(local, job.signApks).then(
              (sha) => `Signed ${name} with your key (certificate SHA-256 ${sha.slice(0, 16)}…).`,
              (e: unknown) => {
                lines.push(`Signing ${rel} failed, so it wasn't kept: ${e instanceof Error ? e.message : String(e)}`);
                return null;
              },
            );
            if (!signed) continue;
            lines.push(signed);
          }
          if (rel === job.installApk) apkLocal = local;
          if (job.artifacts.includes(rel)) {
            lines.push(`Artifact ${rel}: ${await this.daemon.upload(args.jobId, name, local).catch((e) => `(upload failed: ${e})`)}`);
          }
        }
        // 4. Install straight from the Mac.
        if (args.install) {
          progress("Installing on the phone");
          const r = apkLocal ? await this.install(apkLocal, args.serial) : { ok: false, text: "the APK wasn't produced" };
          lines.push(r.ok ? r.text : `Install failed: ${r.text}`);
        }
      }
      lines.push("", "End of the log:", capText(logText.trim(), 12_000) || "(empty)");
      return { ok: res.code === 0, text: lines.join("\n") };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  /**
   * Fail closed, before every job: from inside, the build container must be
   * unable to reach a service on the Mac's localhost (this agent listens on
   * one for the test) or the homelab, yet reach its own loopback and the
   * internet. If that doesn't hold, nothing runs.
   */
  private async checkContainment(): Promise<string | null> {
    const srv = createServer((c) => c.destroy());
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = (srv.address() as { port: number }).port;
    try {
      const r = await this.wrapper(["probe", this.host.macAddress, String(port), this.daemon.host, String(this.daemon.port)]);
      if (r.code !== 0) return `The build VM isn't working (${r.stderr.trim() || `exit ${r.code}`}).`;
      const p = JSON.parse(r.stdout.toString()) as { own: string; other: string; homelab: string; internet: string };
      if (p.other !== "refused" || p.homelab !== "refused") {
        return "Refused on the Mac: the build VM's firewall isn't containing builds (they could reach the Mac's own services or the homelab), so no job runs until that's fixed. Tell the user.";
      }
      if (p.own !== "connected") return "The build container can't reach its own loopback, which Gradle needs.";
      if (p.internet !== "connected") return "The build VM has no internet access, which builds need for their dependencies.";
      return null;
    } finally {
      srv.close();
    }
  }
}

/**
 * The newest complete, non-blank line of a stream of output, without terminal
 * colour codes; null when a chunk ends none.
 */
export class LastLine {
  private partial = "";

  push(chunk: Buffer): string | null {
    const lines = (this.partial + chunk.toString()).split(/\r?\n|\r/);
    this.partial = (lines.pop() ?? "").slice(-2000);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim();
      if (line) return line.slice(0, 300);
    }
    return null;
  }
}

/** Upload helper for Daemon.upload. */
export async function putFile(url: string, headers: Record<string, string>, file: string): Promise<string> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/octet-stream" },
    body: createReadStream(file) as unknown as BodyInit,
    duplex: "half",
  } as RequestInit);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()) as { path: string }).path;
}
