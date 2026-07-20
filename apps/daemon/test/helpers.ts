import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Config } from "../src/config.js";
import type { DB } from "../src/db/index.js";
import * as schema from "../src/db/schema.js";

/**
 * An in-memory database seeded with the daemon's real DDL. Same drizzle handle
 * the daemon uses, so tests exercise the actual queries — just without touching
 * disk. Reuse the returned `db` across EventLog instances to simulate a restart
 * (the row data survives; only the in-memory seq cache is rebuilt).
 */
export function makeTestDb(): DB {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  sqlite.exec(schema.DDL);
  return db;
}

/** A fully-populated Config pointing at throwaway temp dirs. */
export function makeTestConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = mkdtempSync(join(tmpdir(), "crc-data-"));
  return {
    reposRoot: mkdtempSync(join(tmpdir(), "crc-repos-")),
    dataDir,
    dbPath: resolve(dataDir, "crc.sqlite"),
    worktreesDir: resolve(dataDir, "worktrees"),
    authToken: "test-token",
    controlIdleMs: 15 * 60_000,
    permissionTimeoutMs: 300_000,
    port: 4517,
    host: "127.0.0.1",
    forcePermissionPrompts: false,
    expoPushUrl: "https://example.invalid/push",
    rotation: {
      enabled: false,
      cswapBin: "cswap",
      threshold: 90,
      cooldownMs: 5 * 60_000,
      pollMs: 60_000,
      strategy: "best",
      autoRetry: true,
    },
    usageConfigPath: resolve(dataDir, "usage-accounts.json"),
    usageBaseUrl: "https://example.invalid",
    ...overrides,
  };
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

/**
 * Create a real git repo (one commit on `main`) under `reposRoot`, so
 * SessionManager.createSession can add genuine worktrees against it. Returns the
 * repo id the manager will resolve it by (its slugged folder name).
 */
export function makeTestRepo(reposRoot: string, name = "demo"): { repoId: string; repoPath: string } {
  const repoPath = join(reposRoot, name);
  execFileSync("git", ["init", "-b", "main", repoPath], { stdio: "ignore" });
  writeFileSync(join(repoPath, "README.md"), "# demo\n");
  git(repoPath, "add", "-A");
  git(repoPath, "commit", "-m", "init");
  return { repoId: name, repoPath };
}

/** Best-effort cleanup of temp dirs a config created. */
export function cleanupConfig(config: Config): void {
  for (const dir of [config.dataDir, config.reposRoot]) {
    rmSync(dir, { recursive: true, force: true });
  }
}
