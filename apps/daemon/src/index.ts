import { AccountRotator } from "./accounts/rotator.js";
import { UsageReader } from "./accounts/usage.js";
import { hasCapabilities, setCapabilities } from "./claude/capabilities.js";
import { warmUpCapabilities } from "./claude/runner.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { migrateSessionIds } from "./db/migrateSessionIds.js";
import { logger } from "./logger.js";
import { DeviceRegistry } from "./push/devices.js";
import { Notifier } from "./push/notifier.js";
import { PushTokenStore } from "./push/tokens.js";
import { SessionManager } from "./sessions/manager.js";
import { createServer } from "./server/http.js";
import { PermissionBroker } from "./server/permissions.js";

/**
 * Daemon entry point. Boots persistence + the session manager, then serves the
 * combined HTTP/WS API. Also runs the idle-lock sweep so a session never stays
 * locked to a device that wandered off without disconnecting cleanly.
 */
async function main() {
  const config = loadConfig();
  const db = openDb(config);
  await migrateSessionIds(config, db);
  const manager = new SessionManager(config, db);
  // Any session left "busy" survived a hard restart mid-turn — see the
  // method's own comment for why that otherwise wedges it forever.
  manager.reconcileOrphanedTurns();
  const broker = new PermissionBroker(config.permissionTimeoutMs);
  const devices = new DeviceRegistry();
  const pushTokens = new PushTokenStore(db);
  const notifier = new Notifier(config, manager, devices, pushTokens);
  notifier.attach();
  const usageReader = new UsageReader(config.usageConfigPath, config.usageBaseUrl);
  const accounts = new AccountRotator(config, manager, usageReader);
  manager.setAutoSwitch(accounts); // lets a rate-limited turn switch + retry
  accounts.setOnSwitched(() => manager.recycleIdleLiveSessions()); // idle processes may cache the old account's creds
  accounts.start();

  const app = await createServer(config, { manager, broker, pushTokens, devices, accounts, usage: usageReader });
  await app.listen({ host: config.host, port: config.port });
  logger.info("daemon listening", { url: `http://${config.host}:${config.port}`, reposRoot: config.reposRoot });

  // Fire-and-forget: populates the model/slash-command picker before the
  // first real prompt runs, instead of leaving it empty until then. Doesn't
  // block the server from accepting connections.
  if (!hasCapabilities()) {
    void warmUpCapabilities(config.reposRoot).then((caps) => {
      if (caps) setCapabilities(caps);
    });
  }

  const sweep = startIdleSweep(manager, config.controlIdleMs);

  const shutdown = async (signal: string) => {
    logger.info("shutting down", { signal });
    clearInterval(sweep);
    accounts.stop();
    // Kill every live `claude` child; in-flight turns fail cleanly and resume on the next prompt after restart.
    manager.closeAll("shutdown");
    await app.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

/**
 * Every 30s, release control on any idle session whose controller has been
 * silent past the timeout. We never touch a `busy` session — a long-running
 * turn is legitimate activity even if no message has been sent.
 */
function startIdleSweep(manager: SessionManager, idleMs: number): NodeJS.Timeout {
  const interval = setInterval(() => {
    const now = Date.now();
    for (const session of manager.listSessions()) {
      if (!session.controller || session.status === "busy") continue;
      if (now - session.lastActivityAt > idleMs) {
        manager.releaseControl(session.id, session.controller);
        logger.info("auto-released idle control", { sessionId: session.id });
      }
    }
  }, 30_000);
  interval.unref();
  return interval;
}

main().catch((err) => {
  logger.error("daemon failed to start", { err: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
