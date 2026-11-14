import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { logger } from "../logger.js";

/** What Settings shows about auto-deploy. */
export type AutoDeployStatus = {
  enabled: boolean;
  /** The commit this daemon was built from, or null when the build didn't record one. */
  build: string | null;
  /** The newest commit on main, or null when it couldn't be read. */
  latest: string | null;
  /** Main has commits this daemon doesn't. */
  pending: boolean;
  /** One line on what it's doing: "Up to date", "Waiting for 2 busy chats", "Deploying…". */
  state: string;
};

/** Busy for none of this long, so a chat that is about to start isn't caught between the check and the restart. */
export const QUIET_MS = 2 * 60_000;
/** After a deploy attempt, don't try again for this long, whatever happened: a failing build must not loop. */
export const COOLDOWN_MS = 30 * 60_000;

export type AutoDeployDeps = {
  file: string;
  /** The commit baked into this image (see the Dockerfile), or null. */
  buildSha: string | null;
  latestSha: () => Promise<string | null>;
  busyCount: () => number;
  deploy: () => Promise<{ ok: boolean; output: string }>;
  now?: () => number;
};

/**
 * Deploys Renki by itself when main has moved and nothing is running.
 *
 * Off by default, switched on in Settings. Only ever triggers `homelab
 * deploy renki`, the same command a chat runs by hand, and only after every
 * chat has been idle for QUIET_MS. If the build commit is unknown it does
 * nothing, since it can't tell whether there is anything to deploy.
 */
export class AutoDeployer {
  private enabled = false;
  private busySince: number | null = null;
  private idleSince: number | null = null;
  private lastAttempt = 0;
  private latest: string | null = null;
  private state = "Off";
  private checking = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: AutoDeployDeps) {
    try {
      if (existsSync(d.file)) this.enabled = (JSON.parse(readFileSync(d.file, "utf8")) as { enabled?: boolean }).enabled === true;
    } catch {
      // Unreadable: stay off.
    }
    this.state = this.enabled ? "Checking…" : "Off";
  }

  private now(): number {
    return this.d.now ? this.d.now() : Date.now();
  }

  status(): AutoDeployStatus {
    const pending = this.d.buildSha !== null && this.latest !== null && this.latest !== this.d.buildSha;
    return { enabled: this.enabled, build: this.d.buildSha, latest: this.latest, pending, state: this.enabled ? this.state : "Off" };
  }

  setEnabled(enabled: boolean): AutoDeployStatus {
    this.enabled = enabled;
    this.idleSince = null;
    this.state = enabled ? "Checking…" : "Off";
    try {
      writeFileSync(this.d.file, JSON.stringify({ enabled }));
    } catch (err) {
      logger.warn("couldn't save auto-deploy setting", { err: String(err) });
    }
    if (enabled) void this.check();
    return this.status();
  }

  start(everyMs = 60_000): void {
    this.timer = setInterval(() => void this.check(), everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One look: refresh what main is at, and deploy if it's ahead and everything has been quiet. */
  async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      this.latest = await this.d.latestSha().catch(() => null);
      if (!this.enabled) return;
      const { buildSha, busyCount } = this.d;
      if (buildSha === null) return void (this.state = "Can't tell which version is running (deploy once by hand first)");
      if (this.latest === null) return void (this.state = "Can't reach GitHub to check for updates");
      if (this.latest === buildSha) {
        this.idleSince = null;
        return void (this.state = "Up to date");
      }
      const busy = busyCount();
      if (busy > 0) {
        this.idleSince = null;
        return void (this.state = `Update ready, waiting for ${busy} running ${busy === 1 ? "chat" : "chats"}`);
      }
      const now = this.now();
      this.idleSince ??= now;
      const quiet = now - this.idleSince;
      if (quiet < QUIET_MS) return void (this.state = "Update ready, making sure nothing starts");
      if (now - this.lastAttempt < COOLDOWN_MS) return void (this.state = "Update ready, waiting before the next try");
      this.lastAttempt = now;
      this.state = "Deploying…";
      logger.info("auto-deploy: deploying", { from: buildSha.slice(0, 7), to: this.latest.slice(0, 7) });
      const result = await this.d.deploy();
      // Reaching here means this daemon survived the deploy, so it didn't restart: say what happened.
      this.state = result.ok ? "Deploy started" : `Deploy failed: ${result.output.slice(0, 120)}`;
      logger.warn("auto-deploy: finished without restarting", { ok: result.ok, output: result.output.slice(0, 300) });
    } catch (err) {
      this.state = "Check failed";
      logger.warn("auto-deploy check failed", { err: String(err) });
    } finally {
      this.checking = false;
    }
  }
}

/** The commit recorded in the image at build time (BUILD_SHA beside dist), or null. */
export function readBuildSha(path = "BUILD_SHA"): string | null {
  try {
    const s = readFileSync(path, "utf8").trim();
    return /^[0-9a-f]{40}$/.test(s) ? s : null;
  } catch {
    return null;
  }
}

/** `git ls-remote origin main` in the repo, or null on any failure. */
export function latestMainSha(repoDir: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["ls-remote", "origin", "main"], { cwd: repoDir, timeout: 20_000 }, (err, stdout) => {
      const sha = err ? null : stdout.split(/\s/)[0] ?? null;
      resolve(sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null);
    });
  });
}

/** `homelab deploy renki`: detached on the host, and it restarts this very daemon when it gets there. */
export function runHomelabDeploy(): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile("homelab", ["deploy", "renki"], { timeout: 60_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: `${stdout}${stderr}`.trim() });
    });
  });
}
