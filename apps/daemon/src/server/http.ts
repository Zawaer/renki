import websocketPlugin from "@fastify/websocket";
import { CreateSessionRequest } from "@crc/protocol";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { Config } from "../config.js";
import { logger } from "../logger.js";
import { scanRepos } from "../repos.js";
import { SessionError } from "../sessions/errors.js";
import type { SessionManager } from "../sessions/manager.js";
import { tokenMatches } from "./auth.js";
import { Connection } from "./connection.js";
import type { PermissionBroker } from "./permissions.js";

/**
 * Builds the single HTTP server that carries BOTH the REST control plane and
 * the WebSocket real-time plane on one port. One port = one thing to expose
 * over the tailnet, one token to check, one origin for the web client.
 *
 * REST = discrete operations (list repos, create/list/archive, fetch
 * transcript). WebSocket = the live conversation. Auth (a shared bearer token)
 * is enforced once, in an onRequest hook, so it covers the WS upgrade too.
 */
export async function createServer(
  config: Config,
  manager: SessionManager,
  broker: PermissionBroker,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Permissive CORS: single-user tool behind a token + tailnet, so we don't
  // need per-origin rules — the web/VS Code clients just need to reach it.
  app.addHook("onRequest", async (req, reply) => {
    reply.header("access-control-allow-origin", req.headers.origin ?? "*");
    reply.header("access-control-allow-methods", "GET,POST,OPTIONS");
    reply.header("access-control-allow-headers", "authorization,content-type");
    if (req.method === "OPTIONS") return reply.code(204).send();
  });

  // Token auth. Skipped when no token is configured (LAN-only dev) and for the
  // unauthenticated health check. Token accepted via Authorization: Bearer, the
  // x-crc-token header, or a ?token= query param (WebSocket-friendly).
  app.addHook("onRequest", async (req, reply) => {
    if (!config.authToken) return;
    if (req.url.startsWith("/health")) return;
    if (!tokenMatches(tokenFrom(req), config.authToken)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/repos", async () => ({ repos: await scanRepos(config) }));

  app.get("/sessions", async () => ({ sessions: manager.listSessions() }));

  app.post("/sessions", async (req, reply) => {
    const parsed = CreateSessionRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues });
    try {
      const session = await manager.createSession(parsed.data);
      return reply.code(201).send({ session });
    } catch (err) {
      return sendSessionError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/sessions/:id/transcript", async (req, reply) => {
    try {
      const session = manager.getSession(req.params.id);
      return { session, events: manager.events.read(req.params.id) };
    } catch (err) {
      return sendSessionError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/sessions/:id/archive", async (req, reply) => {
    try {
      return { session: await manager.archiveSession(req.params.id) };
    } catch (err) {
      return sendSessionError(reply, err);
    }
  });

  // ── WebSocket ────────────────────────────────────────────────────────────
  await app.register(websocketPlugin);
  app.get<{ Querystring: { deviceId?: string; deviceName?: string } }>(
    "/ws",
    { websocket: true },
    (socket: WebSocket, req: FastifyRequest<{ Querystring: { deviceId?: string; deviceName?: string } }>) => {
      const deviceId = req.query.deviceId?.trim();
      if (!deviceId) {
        socket.close(1008, "deviceId required");
        return;
      }
      const deviceName = req.query.deviceName?.trim() || null;
      new Connection(socket, deviceId, deviceName, manager, broker);
      logger.info("connection opened", { deviceId, deviceName });
    },
  );

  return app;
}

function tokenFrom(req: FastifyRequest): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const header = req.headers["x-crc-token"];
  if (typeof header === "string") return header;
  const q = (req.query as { token?: string } | undefined)?.token;
  return typeof q === "string" ? q : undefined;
}

function sendSessionError(reply: FastifyReply, err: unknown) {
  if (err instanceof SessionError) {
    const status = err.code === "session_not_found" || err.code === "repo_not_found" ? 404 : 409;
    return reply.code(status).send({ error: err.code, message: err.message });
  }
  logger.error("request failed", { err: err instanceof Error ? err.stack : String(err) });
  return reply.code(500).send({ error: "internal" });
}
