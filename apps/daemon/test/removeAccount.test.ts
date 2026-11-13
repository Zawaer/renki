import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Account } from "@renki/protocol";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { RestClient } from "../../../packages/client-core/src/rest.js";
import { Cswap, CswapError, cswapErrorLine } from "../src/accounts/cswap.js";
import { AccountRotator } from "../src/accounts/rotator.js";
import { UsageReader } from "../src/accounts/usage.js";
import type { Config } from "../src/config.js";
import { DeviceRegistry } from "../src/push/devices.js";
import { PushTokenStore } from "../src/push/tokens.js";
import { createServer } from "../src/server/http.js";
import { PermissionBroker } from "../src/server/permissions.js";
import { SessionManager } from "../src/sessions/manager.js";
import { cleanupConfig, makeTestConfig, makeTestDb } from "./helpers.js";

/**
 * Removing accounts from Settings: a coding account goes through `cswap
 * remove`, a usage-only account through the usage key store. A fake `cswap`
 * script stands in for the real one, behaving the way claude-swap 0.29 does:
 * `remove` has no --yes, asks "[y/N]" on stdin, prints "Removed Account-N",
 * and prints "Cancelled" (exit 0) for any other answer.
 */

const dirs: string[] = [];
const configs: Config[] = [];
const servers: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of servers.splice(0)) await app.close();
  for (const c of configs.splice(0)) cleanupConfig(c);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function account(number: number, email: string, active = false): Account {
  return { number, email, active, usageStatus: "ok", usageError: null, usage: null };
}

/** A fake cswap whose `--list --json` prints `accounts` and whose `remove` logs what it removed. */
function fakeCswapBin(accounts: Account[]): { bin: string; removed: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), "renki-cswap-"));
  dirs.push(dir);
  const active = accounts.find((a) => a.active)?.number ?? null;
  writeFileSync(join(dir, "list.json"), JSON.stringify({ activeAccountNumber: active, accounts }));
  const bin = join(dir, "cswap");
  writeFileSync(
    bin,
    `#!/bin/sh
dir="$(dirname "$0")"
case "$1" in
  --list) cat "$dir/list.json" ;;
  remove)
    if [ "$2" = "404" ]; then echo "Error: No account found with identifier: 404" >&2; exit 1; fi
    printf 'Are you sure you want to permanently remove Account-%s (x)? [y/N] ' "$2"
    read ans
    if [ "$ans" = "y" ]; then echo "Removed Account-$2 (x)"; echo "$2" >> "$dir/removed"; else echo "Cancelled"; fi ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  const removedPath = join(dir, "removed");
  return { bin, removed: () => (existsSync(removedPath) ? readFileSync(removedPath, "utf8").trim().split("\n") : []) };
}

async function startServer(accounts: Account[], usageEntries: unknown[] = []) {
  const fake = fakeCswapBin(accounts);
  const config = makeTestConfig();
  config.rotation.cswapBin = fake.bin;
  configs.push(config);
  writeFileSync(config.usageConfigPath, JSON.stringify(usageEntries));
  const db = makeTestDb();
  const manager = new SessionManager(config, db);
  const usage = new UsageReader(config.usageConfigPath, config.usageBaseUrl);
  const rotator = new AccountRotator(config, manager, usage);
  const app = await createServer(config, {
    manager,
    broker: new PermissionBroker(config.permissionTimeoutMs),
    pushTokens: new PushTokenStore(db),
    devices: new DeviceRegistry(),
    accounts: rotator,
    usage,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  servers.push(app);
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { baseUrl, config, rotator, usage, removed: fake.removed, rest: new RestClient({ baseUrl, token: config.authToken }) };
}

describe("Cswap.remove", () => {
  it("answers cswap's confirmation with y and removes by number", async () => {
    const fake = fakeCswapBin([]);
    await new Cswap(fake.bin).remove(3);
    expect(fake.removed()).toEqual(["3"]);
  });

  it("fails with cswap's own error line", async () => {
    const fake = fakeCswapBin([]);
    await expect(new Cswap(fake.bin).remove(404)).rejects.toThrow("No account found with identifier: 404");
  });

  it("doesn't take a 'Cancelled' with exit 0 for success", async () => {
    const dir = mkdtempSync(join(tmpdir(), "renki-cswap-"));
    dirs.push(dir);
    const bin = join(dir, "cswap");
    writeFileSync(bin, "#!/bin/sh\nprintf 'Sure? [y/N] '\nread ans\necho Cancelled\n");
    chmodSync(bin, 0o755);
    const err = await new Cswap(bin).remove(2).catch((e) => e);
    expect(err).toBeInstanceOf(CswapError);
    expect(err.message).toBe("Cancelled");
  });

  it("cswapErrorLine strips the prompt and colour", () => {
    expect(cswapErrorLine("Are you sure? [y/N] \x1b[31mError: Account-9 does not exist\x1b[0m\n")).toBe("Account-9 does not exist");
    expect(cswapErrorLine("")).toBeNull();
  });
});

describe("DELETE /accounts/:number (rest.removeAccount)", () => {
  const roster = () => [account(1, "main@example.com", true), account(2, "spare@example.com"), account(3, "old@example.com")];

  it("removes an inactive account through cswap", async () => {
    const { rest, removed } = await startServer(roster());
    const res = await rest.removeAccount(2, "spare@example.com");
    expect(res).toEqual({ ok: true, email: "spare@example.com", message: null });
    expect(removed()).toEqual(["2"]);
  });

  it("refuses the account in use, and leaves cswap alone", async () => {
    const { rest, removed } = await startServer(roster());
    const res = await rest.removeAccount(1, "main@example.com");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/main@example\.com is the account in use\. Switch to another account first/);
    expect(removed()).toEqual([]);
  });

  it("refuses when the number now belongs to a different account", async () => {
    const { rest, removed } = await startServer(roster());
    const res = await rest.removeAccount(3, "spare@example.com");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/#3 is now old@example\.com/);
    expect(removed()).toEqual([]);
  });

  it("says so when the account is already gone", async () => {
    const { rest } = await startServer(roster());
    const res = await rest.removeAccount(7, "x@example.com");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/no account #7/);
  });

  it("clears the preferred account when that's the one removed", async () => {
    const { rest, rotator } = await startServer(roster());
    rotator.updateSettings({ preferredEmail: "spare@example.com" });
    await rest.removeAccount(2, "spare@example.com");
    expect(rotator.status().preferredEmail).toBeNull();
  });

  it("rejects a malformed number and needs the token", async () => {
    const { baseUrl, config } = await startServer(roster());
    const auth = { authorization: `Bearer ${config.authToken}` };
    expect((await fetch(`${baseUrl}/accounts/abc`, { method: "DELETE", headers: auth })).status).toBe(400);
    expect((await fetch(`${baseUrl}/accounts/0`, { method: "DELETE", headers: auth })).status).toBe(400);
    expect((await fetch(`${baseUrl}/accounts/2`, { method: "DELETE" })).status).toBe(401);
  });
});

describe("DELETE /accounts/usage-key/:email (rest.disconnectUsageKey)", () => {
  it("removes a usage-only account's key and says when there's none", async () => {
    const entries = [
      { email: "watch@example.com", sessionKey: "sk-ant-sid01-a", orgId: "org-a" },
      { email: "keep@example.com", sessionKey: "sk-ant-sid01-b", orgId: "org-b" },
    ];
    const { rest, config, usage, removed } = await startServer([account(1, "main@example.com", true)], entries);

    expect(await rest.disconnectUsageKey("Watch@Example.com")).toEqual({ ok: true, message: null });
    expect(usage.connectedEmails()).toEqual(["keep@example.com"]);
    const saved = JSON.parse(readFileSync(config.usageConfigPath, "utf8"));
    expect(saved.map((e: { email: string }) => e.email)).toEqual(["keep@example.com"]);
    expect(removed()).toEqual([]); // cswap is never involved

    const again = await rest.disconnectUsageKey("watch@example.com");
    expect(again.ok).toBe(false);
    expect(again.message).toMatch(/No usage key is connected for watch@example\.com/);
  });
});
