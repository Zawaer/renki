import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../logger.js";

/**
 * Which repos' chats may use the `homelab` command (see ./homelabGuard.ts), as
 * set in Settings > Homelab access. Lives in `<dataDir>/homelab-access.json`,
 * read on every check, so a change applies to the next command, even in chats
 * already running. Until it's first saved, RENKI_HOMELAB_REPOS is the value.
 *
 * `null` = not enforced (every chat). `@plain` = chats without a repo.
 */
export class HomelabAccess {
  private readonly path: string;

  constructor(
    dataDir: string,
    private readonly fromEnv: string[] | null,
  ) {
    this.path = resolve(dataDir, "homelab-access.json");
  }

  get(): string[] | null {
    if (!existsSync(this.path)) return this.fromEnv;
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8")) as { repos?: unknown };
      if (data.repos === null) return null;
      if (Array.isArray(data.repos)) return data.repos.filter((r): r is string => typeof r === "string").map((r) => r.toLowerCase());
    } catch (err) {
      logger.warn("homelab-access.json unreadable; nobody gets homelab access until it's saved again", { err: String(err) });
    }
    return []; // a broken file fails closed
  }

  set(repos: string[] | null): string[] | null {
    const value = repos === null ? null : [...new Set(repos.map((r) => r.trim().toLowerCase()).filter(Boolean))].sort();
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ repos: value }, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.path);
    logger.info("homelab access changed", { repos: value });
    return value;
  }
}
