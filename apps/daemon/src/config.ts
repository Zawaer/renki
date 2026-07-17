import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";

/**
 * Daemon configuration, resolved once at startup from environment variables
 * with sensible homelab defaults. Kept tiny and explicit — no config files yet;
 * everything the daemon needs to find repos and store its data lives here.
 */
const Env = z.object({
  /** Directory that CONTAINS your git project folders (each subfolder = a repo). */
  CRC_REPOS_ROOT: z.string().min(1).default(resolve(homedir(), "coding")),
  /** Where the daemon keeps its SQLite db and per-session worktrees. */
  CRC_DATA_DIR: z.string().min(1).default(resolve(process.cwd(), "data")),
  /** Shared secret clients must present (used from Step 4 onward). */
  CRC_AUTH_TOKEN: z.string().min(1).optional(),
  /** Idle minutes before the take-control lock auto-releases. */
  CRC_CONTROL_IDLE_MINUTES: z.coerce.number().int().positive().default(15),
});

export type Config = {
  reposRoot: string;
  dataDir: string;
  dbPath: string;
  worktreesDir: string;
  authToken: string | undefined;
  controlIdleMs: number;
};

export function loadConfig(): Config {
  const env = Env.parse(process.env);
  const dataDir = resolve(env.CRC_DATA_DIR);
  return {
    reposRoot: resolve(env.CRC_REPOS_ROOT),
    dataDir,
    dbPath: resolve(dataDir, "crc.sqlite"),
    worktreesDir: resolve(dataDir, "worktrees"),
    authToken: env.CRC_AUTH_TOKEN,
    controlIdleMs: env.CRC_CONTROL_IDLE_MINUTES * 60_000,
  };
}
