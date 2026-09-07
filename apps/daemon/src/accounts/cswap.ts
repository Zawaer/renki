import { execFile, spawn } from "node:child_process";
import type { Account } from "@crc/protocol";
import { logger } from "../logger.js";

/**
 * Thin, safe wrapper around the `cswap` CLI. cswap owns everything dangerous —
 * reading Anthropic usage endpoints and swapping which account's credentials
 * the official `claude` CLI loads at startup (holding Claude Code's own
 * credential locks so a swap never interleaves with a token refresh). We only
 * ever invoke cswap; we never touch tokens ourselves. That's what keeps this
 * on the compliant side of the ToS line.
 */

export class CswapError extends Error {}

export type CswapList = {
  activeAccountNumber: number | null;
  accounts: Account[];
};

export class Cswap {
  constructor(private readonly bin: string) {}

  /** `cswap --list --json` → normalized accounts + usage. */
  async list(): Promise<CswapList> {
    const raw = await this.run(["--list", "--json"]);
    const accounts: Account[] = Array.isArray(raw?.accounts) ? raw.accounts.map((a: unknown) => normalizeAccount(a)) : [];
    const activeAccountNumber =
      typeof raw?.activeAccountNumber === "number"
        ? raw.activeAccountNumber
        : (accounts.find((a) => a.active)?.number ?? null);
    return { activeAccountNumber, accounts };
  }

  /** Rotate to the best/next account per strategy. Returns the new active number. */
  async switch(strategy: "best" | "next-available"): Promise<number | null> {
    const raw = await this.run(["--switch", "--strategy", strategy, "--json"]);
    return readActiveNumber(raw);
  }

  /** Switch to a specific account (number or email). */
  async switchTo(target: number | string): Promise<number | null> {
    const raw = await this.run(["--switch-to", String(target), "--json"]);
    return readActiveNumber(raw);
  }

  /**
   * Register a new account from a `claude setup-token` value (or a plain API
   * key) — `cswap add-token -`. The token is written to the child's stdin
   * rather than passed as an argv entry, exactly like the piped form cswap's
   * own docs recommend (`claude setup-token | cswap add-token -`), so it
   * never appears in a process listing or in our own error messages.
   */
  async addToken(token: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.bin, ["add-token", "-"], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new CswapError("cswap add-token timed out"));
      }, 30_000);
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new CswapError(`cswap add-token failed to start: ${err.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) return resolve();
        reject(new CswapError(`cswap add-token failed (exit ${code}): ${(stderr || stdout).trim()}`));
      });
      child.stdin.write(token);
      child.stdin.end();
    });
  }

  private run(args: string[]): Promise<any> {
    return new Promise((resolve, reject) => {
      execFile(this.bin, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          return reject(new CswapError(`cswap ${args.join(" ")} failed: ${err.message} ${stderr ?? ""}`.trim()));
        }
        try {
          resolve(JSON.parse(stdout.toString() || "{}"));
        } catch {
          logger.warn("cswap returned non-JSON", { args });
          reject(new CswapError(`cswap ${args.join(" ")} returned non-JSON output`));
        }
      });
    });
  }
}

/** Coerce a cswap account row into our strict Account shape, tolerating drift. */
function normalizeAccount(a: any): Account {
  const usage =
    a?.usage && a.usage.fiveHour && a.usage.sevenDay
      ? {
          fiveHour: { pct: Number(a.usage.fiveHour.pct ?? 0), resetsAt: a.usage.fiveHour.resetsAt ?? null },
          sevenDay: { pct: Number(a.usage.sevenDay.pct ?? 0), resetsAt: a.usage.sevenDay.resetsAt ?? null },
          // cswap reports only the two headline windows; the per-model weekly
          // caps come from the usage reader, which overwrites this whole object.
          limits: Array.isArray(a.usage.limits) ? a.usage.limits : [],
          extra:
            a.usage.extra && typeof a.usage.extra.pct === "number"
              ? {
                  pct: Number(a.usage.extra.pct),
                  usedDollars: Number(a.usage.extra.usedDollars ?? 0),
                  limitDollars: Number(a.usage.extra.limitDollars ?? 0),
                  currency: String(a.usage.extra.currency ?? "USD"),
                }
              : null,
        }
      : null;
  return {
    number: Number(a?.number ?? 0),
    email: String(a?.email ?? ""),
    active: Boolean(a?.active),
    usageStatus: String(a?.usageStatus ?? "unavailable"),
    usage,
  };
}

function readActiveNumber(raw: any): number | null {
  if (typeof raw?.activeAccountNumber === "number") return raw.activeAccountNumber;
  if (typeof raw?.active?.number === "number") return raw.active.number;
  return null;
}
