import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { MAC_VERBS, MacName, MacRelPath, type MacJobInfo, type MacVerb } from "@renki/protocol";
import { z } from "zod";

/**
 * ~/Library/Application Support/Renki/mac-node.json (or $RENKI_MAC_CONFIG).
 * Lives on the Mac only: nothing on the homelab can change which verbs run here.
 */
export const CONFIG_DIR = join(homedir(), "Library", "Application Support", "Renki");
export const CONFIG_PATH = process.env.RENKI_MAC_CONFIG ?? join(CONFIG_DIR, "mac-node.json");

const File = z.object({
  /** The daemon's base URL, as the web client uses it, e.g. https://renki.internal/api */
  url: z.string().url(),
  token: z.string().min(1),
  /** Shown to the daemon and in Claude's messages. */
  name: z.string().max(100).optional(),
  adb: z.string().optional(),
  /** Switch single verbs off, e.g. { "shell": false }. Unlisted verbs are on. */
  verbs: z.record(z.string(), z.boolean()).optional(),
  /**
   * Build jobs per project (the session's repo name). The ONLY place a command
   * that runs on this Mac is written: sessions can name a job, never send one.
   */
  jobs: z
    .record(
      MacName,
      z.record(
        MacName,
        z.object({
          description: z.string().max(300).default(""),
          command: z.string().min(1).max(4000),
          /** Folder inside the project to run in. */
          cwd: MacRelPath.optional(),
          timeoutMinutes: z.number().int().min(1).max(60).default(20),
          /** Files sent back to the homelab after a successful run. */
          artifacts: z.array(MacRelPath).max(10).default([]),
          /** The APK `install: true` puts on the phone. */
          installApk: MacRelPath.optional(),
        }),
      ),
    )
    .default({}),
  /** The build VM (a Colima profile used for nothing else). See vm.ts. */
  runner: z
    .object({
      profile: z.string().regex(/^[\w-]+$/).default("renki-runner"),
      cpus: z.number().int().min(1).max(32).default(6),
      memoryGb: z.number().min(2).max(64).default(8),
      diskGb: z.number().int().min(20).max(500).default(40),
      colima: z.string().default("/opt/homebrew/bin/colima"),
      docker: z.string().default("/opt/homebrew/bin/docker"),
    })
    .default({ profile: "renki-runner", cpus: 6, memoryGb: 8, diskGb: 40, colima: "/opt/homebrew/bin/colima", docker: "/opt/homebrew/bin/docker" }),
});

export type JobConfig = z.infer<typeof File>["jobs"][string][string];
export type RunnerConfig = z.infer<typeof File>["runner"];

export type Config = {
  url: string;
  token: string;
  name: string;
  adb: string;
  verbs: MacVerb[];
  jobs: Record<string, Record<string, JobConfig>>;
  /** Null when Colima or Docker isn't installed. */
  runner: RunnerConfig | null;
};

/** What the daemon (and so Claude) gets to know about the jobs: names and descriptions, never commands. */
export function jobInfo(c: Config): Record<string, MacJobInfo[]> {
  return Object.fromEntries(
    Object.entries(c.jobs).map(([project, jobs]) => [
      project,
      Object.entries(jobs).map(([name, j]) => ({ name, description: j.description, installs: !!j.installApk })),
    ]),
  );
}

export function loadConfig(path = CONFIG_PATH): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Can't read ${path}: ${err instanceof Error ? err.message : String(err)}. Run macos/setup.sh first.`);
  }
  const f = File.parse(raw);
  const runner = existsSync(f.runner.colima) && existsSync(f.runner.docker) ? f.runner : null;
  return {
    url: f.url.replace(/\/+$/, ""),
    token: f.token,
    name: f.name ?? hostname().replace(/\.local$/, ""),
    adb: f.adb ?? "/opt/homebrew/bin/adb",
    verbs: MAC_VERBS.filter((v) => f.verbs?.[v] !== false && (v !== "run" || (runner !== null && Object.keys(f.jobs).length > 0))),
    jobs: f.jobs,
    runner,
  };
}
