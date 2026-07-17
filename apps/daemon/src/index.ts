import { AccountRotator } from "./accounts/rotator.js";
import { UsageReader } from "./accounts/usage.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";
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
  const manager = new SessionManager(config, db);
  const broker = new PermissionBroker(config.permissionTimeoutMs);
  const devices = new DeviceRegistry();
  const pushTokens = new PushTokenStore(db);
  const notifier = new Notifier(config, manager, devices, pushTokens);
  notifier.attach();
  const usageReader = new UsageReader(config.usageConfigPath, config.usageBaseUrl);
  const accounts = new AccountRotator(config, manager, usageReader);
  manager.setAutoSwitch(accounts); // lets a rate-limited turn switch + retry
  accounts.start();

  // Safety: never expose an UNAUTHENTICATED daemon beyond loopback. Binding a
  // non-loopback host (e.g. the tailnet IP or 0.0.0.0) with no token would put
  // an open "run anything on my machine" API on the network. Refuse unless the
  // operator explicitly opts in with CRC_ALLOW_INSECURE.
  if (!config.authToken && !isLoopback(config.host) && !config.allowInsecure) {
    logger.error(
      "refusing to bind a non-loopback host with no CRC_AUTH_TOKEN — set a token, " +
        "or (not recommended) CRC_ALLOW_INSECURE=1",
      { host: config.host },
    );
    process.exit(1);
  }

  const app = await createServer(config, { manager, broker, pushTokens, devices, accounts });
  await app.listen({ host: config.host, port: config.port });
  logger.info("daemon listening", {
    url: `http://${config.host}:${config.port}`,
    reposRoot: config.reposRoot,
    authRequired: Boolean(config.authToken),
  });
  if (!config.authToken) {
    logger.warn("no CRC_AUTH_TOKEN set — API is open to anyone who can reach the port");
  }

  const sweep = startIdleSweep(manager, config.controlIdleMs);

  const shutdown = async (signal: string) => {
    logger.info("shutting down", { signal });
    clearInterval(sweep);
    accounts.stop();
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

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

main().catch((err) => {
  logger.error("daemon failed to start", { err: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
