import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
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
  /** Seconds a pending permission request waits for the controller before denying. */
  CRC_PERMISSION_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),
  /** Port the HTTP+WS server listens on. */
  CRC_PORT: z.coerce.number().int().positive().default(4517),
  /** Address to bind. Default localhost; set to the tailnet IP in Step 4. */
  CRC_HOST: z.string().min(1).default("127.0.0.1"),
  /**
   * When "1"/"true", ignore your personal ~/.claude allow-lists (settingSources
   * = []) so EVERY gated tool routes through the controller's approval. When
   * off, the daemon inherits your normal Claude Code settings.
   */
  CRC_FORCE_PERMISSION_PROMPTS: z.string().optional(),
  /** Escape hatch to allow binding a non-loopback host with no auth token. */
  CRC_ALLOW_INSECURE: z.string().optional(),
  /** Expo push endpoint (override to a mock in tests). */
  CRC_EXPO_PUSH_URL: z.string().url().default("https://exp.host/--/api/v2/push/send"),

  // ── multi-account usage rotation (cswap) ──
  /** Enable automatic account rotation. Off by default. */
  CRC_ACCOUNT_ROTATION: z.string().optional(),
  /** cswap executable (name on PATH or absolute path). */
  CRC_CSWAP_BIN: z.string().min(1).default("cswap"),
  /** Switch when the active account's 5h or 7d usage reaches this percent. */
  CRC_ROTATION_THRESHOLD: z.coerce.number().min(1).max(100).default(90),
  /** Minutes between switches (avoids flip-flopping near the threshold). */
  CRC_ROTATION_COOLDOWN_MINUTES: z.coerce.number().positive().default(5),
  /** How often to poll cswap for usage. */
  CRC_ROTATION_POLL_SECONDS: z.coerce.number().int().positive().default(60),
  /** cswap --switch strategy. */
  CRC_ROTATION_STRATEGY: z.enum(["best", "next-available"]).default("best"),
  /** On a rate-limit failure, switch accounts and retry the prompt once. */
  CRC_ROTATION_AUTORETRY: z.string().optional(),
  /**
   * JSON file of claude.ai session keys for usage %:
   *   [{ "email": "...", "sessionKey": "sk-ant-sid01-...", "orgId": "..." }]
   * Read-only usage display only; separate from the coding setup-tokens.
   */
  CRC_USAGE_CONFIG: z.string().optional(),
  /** Base URL for the usage endpoint (override for testing). */
  CRC_USAGE_BASE_URL: z.string().url().default("https://claude.ai"),
  /** Browser channel the Mac guided-login reuses ("chrome"/"msedge"; empty = bundled Chromium). */
  CRC_USAGE_LOGIN_CHANNEL: z.string().default("chrome"),
  /** How long the guided-login browser waits for you to finish signing in. */
  CRC_USAGE_LOGIN_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(180),
});

export type Config = {
  reposRoot: string;
  dataDir: string;
  dbPath: string;
  worktreesDir: string;
  authToken: string | undefined;
  controlIdleMs: number;
  permissionTimeoutMs: number;
  port: number;
  host: string;
  forcePermissionPrompts: boolean;
  allowInsecure: boolean;
  expoPushUrl: string;
  rotation: {
    enabled: boolean;
    cswapBin: string;
    threshold: number;
    cooldownMs: number;
    pollMs: number;
    strategy: "best" | "next-available";
    autoRetry: boolean;
  };
  usageConfigPath: string;
  usageBaseUrl: string;
  usageLoginChannel: string;
  usageLoginTimeoutMs: number;
};

/**
 * Find and load the nearest `.env`, walking up from the current directory to the
 * workspace root. This matters because `pnpm --filter @crc/daemon dev` runs with
 * cwd = apps/daemon, so a plain `process.loadEnvFile()` (which resolves `.env`
 * from cwd) would silently miss the repo-root `.env` the docs tell you to
 * create. We stop at the workspace root (the dir with pnpm-workspace.yaml) so we
 * never wander above the monorepo. Real process env still wins for anything set.
 */
function loadDotEnv(): void {
  let dir = process.cwd();
  for (;;) {
    const envPath = resolve(dir, ".env");
    if (existsSync(envPath)) {
      try {
        process.loadEnvFile(envPath);
      } catch {
        /* unreadable .env — fall back to process env */
      }
      return;
    }
    // Don't climb past the monorepo root.
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return;
    const parent = dirname(dir);
    if (parent === dir) return; // hit the filesystem root
    dir = parent;
  }
}

export function loadConfig(): Config {
  loadDotEnv();

  const env = Env.parse(process.env);
  const dataDir = resolve(env.CRC_DATA_DIR);
  return {
    reposRoot: resolve(env.CRC_REPOS_ROOT),
    dataDir,
    dbPath: resolve(dataDir, "crc.sqlite"),
    worktreesDir: resolve(dataDir, "worktrees"),
    authToken: env.CRC_AUTH_TOKEN,
    controlIdleMs: env.CRC_CONTROL_IDLE_MINUTES * 60_000,
    permissionTimeoutMs: env.CRC_PERMISSION_TIMEOUT_SECONDS * 1000,
    port: env.CRC_PORT,
    host: env.CRC_HOST,
    forcePermissionPrompts: env.CRC_FORCE_PERMISSION_PROMPTS === "1" || env.CRC_FORCE_PERMISSION_PROMPTS === "true",
    allowInsecure: env.CRC_ALLOW_INSECURE === "1" || env.CRC_ALLOW_INSECURE === "true",
    expoPushUrl: env.CRC_EXPO_PUSH_URL,
    rotation: {
      enabled: env.CRC_ACCOUNT_ROTATION === "1" || env.CRC_ACCOUNT_ROTATION === "true",
      cswapBin: env.CRC_CSWAP_BIN,
      threshold: env.CRC_ROTATION_THRESHOLD,
      cooldownMs: env.CRC_ROTATION_COOLDOWN_MINUTES * 60_000,
      pollMs: env.CRC_ROTATION_POLL_SECONDS * 1000,
      strategy: env.CRC_ROTATION_STRATEGY,
      autoRetry: env.CRC_ROTATION_AUTORETRY !== "0" && env.CRC_ROTATION_AUTORETRY !== "false",
    },
    usageConfigPath: env.CRC_USAGE_CONFIG ? resolve(env.CRC_USAGE_CONFIG) : resolve(dataDir, "usage-accounts.json"),
    usageBaseUrl: env.CRC_USAGE_BASE_URL,
    usageLoginChannel: env.CRC_USAGE_LOGIN_CHANNEL,
    usageLoginTimeoutMs: env.CRC_USAGE_LOGIN_TIMEOUT_SECONDS * 1000,
  };
}
