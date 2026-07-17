import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { logger } from "./logger.js";
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

  const app = await createServer(config, manager, broker);
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
