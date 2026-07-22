import websocketPlugin from "@fastify/websocket";
import {
  AddSetupTokenRequest,
  ConnectUsageKeyRequest,
  CreateSessionRequest,
  RegisterPushTokenRequest,
  SwitchAccountRequest,
} from "@crc/protocol";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { loginAndExtractSessionKey, PlaywrightUnavailableError } from "../accounts/login.js";
import type { AccountRotator } from "../accounts/rotator.js";
import type { UsageReader } from "../accounts/usage.js";
import { getCapabilities } from "../claude/capabilities.js";
import { readRtkGain } from "../claude/rtkStats.js";
import type { Config } from "../config.js";
import { logger } from "../logger.js";
import type { DeviceRegistry } from "../push/devices.js";
import type { PushTokenStore } from "../push/tokens.js";
import { scanRepos } from "../repos.js";
import { SessionError } from "../sessions/errors.js";
import type { SessionManager } from "../sessions/manager.js";
import { getTailscaleStatus } from "../tailscale.js";
import { tokenMatches } from "./auth.js";
import { Connection } from "./connection.js";
import type { PermissionBroker } from "./permissions.js";

export type ServerDeps = {
  manager: SessionManager;
  broker: PermissionBroker;
  pushTokens: PushTokenStore;
  devices: DeviceRegistry;
  accounts: AccountRotator;
  usage: UsageReader;
};

/**
 * Builds the single HTTP server that carries BOTH the REST control plane and
 * the WebSocket real-time plane on one port. One port = one thing to expose
 * over the tailnet, one token to check, one origin for the web client.
 *
 * REST = discrete operations (list repos, create/list/archive, fetch
 * transcript). WebSocket = the live conversation. Auth (a shared bearer token)
 * is enforced once, in an onRequest hook, so it covers the WS upgrade too.
 */
export async function createServer(config: Config, deps: ServerDeps): Promise<FastifyInstance> {
  const { manager, broker, pushTokens, devices, accounts, usage } = deps;
  const app = Fastify({ logger: false });

  // Every live connection gets every session-roster change, unconditionally —
  // single-user tool, cheap, and avoids a separate subscribe/unsubscribe
  // handshake just for a list view. Per-session detail still goes through the
  // event log/`subscribe` (see Connection.subscribe) — this is roster-only.
  const liveConnections = new Set<Connection>();
  manager.setBroadcast({
    onSessionChanged: (session) => {
      for (const conn of liveConnections) conn.notify({ type: "session", session });
    },
    onSessionRemoved: (sessionId) => {
      for (const conn of liveConnections) conn.notify({ type: "session_removed", sessionId });
    },
  });

  // Registered before any hook that might short-circuit a request (CORS,
  // auth below): @fastify/websocket adds its own onRequest hook that flags
  // upgrade requests so its onResponse hook knows to destroy the raw socket
  // afterward. If auth rejects a WS upgrade first, later onRequest hooks —
  // including this plugin's — never run, that flag never gets set, and the
  // socket leaks forever. Registering it first means its hook always runs
  // regardless of what auth decides.
  await app.register(websocketPlugin);

  // Permissive CORS: single-user tool behind a token + tailnet, so we don't
  // need per-origin rules — the web/VS Code clients just need to reach it.
  app.addHook("onRequest", async (req, reply) => {
    reply.header("access-control-allow-origin", req.headers.origin ?? "*");
    reply.header("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
    reply.header("access-control-allow-headers", "authorization,content-type");
    if (req.method === "OPTIONS") return reply.code(204).send();
  });

  // Token auth (skipped only for the unauthenticated health check). Token
  // accepted via Authorization: Bearer, the x-crc-token header, or a ?token=
  // query param (WebSocket-friendly).
  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/health")) return;
    if (!tokenMatches(tokenFrom(req), config.authToken)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/repos", async () => ({ repos: await scanRepos(config), root: config.reposRoot }));

  // Lets a client connected via a loopback or private-CA'd address suggest a
  // real, shareable one when showing a pairing QR — see tailscale.ts.
  app.get("/tailscale-status", async () => getTailscaleStatus(config.port));

  app.get("/sessions", async () => ({ sessions: manager.listSessions() }));

  // Cost/token/wait-time analytics across every session, for the Stats page.
  app.get("/stats", async () => manager.events.statsSummary());

  // Empty until the first turn runs this process's lifetime — only obtainable
  // from a live SDK Query object (see claude/capabilities.ts).
  app.get("/capabilities", async () => getCapabilities());

  // RTK (rtk-ai/rtk) token-savings stats, if CRC_ENABLE_RTK is on. Self-describing
  // response (enabled/available) rather than a separate feature-flag endpoint —
  // same idiom as /accounts.
  app.get("/rtk/gain", async () => {
    if (!config.enableRtk) return { enabled: false, available: false, error: null, summary: null, daily: [] };
    return readRtkGain(config.rtkBin);
  });

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

  app.delete<{ Params: { id: string } }>("/sessions/:id", async (req, reply) => {
    try {
      await manager.deleteSession(req.params.id);
      return { ok: true };
    } catch (err) {
      return sendSessionError(reply, err);
    }
  });

  // Register/refresh a device's Expo push token (empty token unregisters).
  app.post("/devices/push-token", async (req, reply) => {
    const parsed = RegisterPushTokenRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    pushTokens.set(parsed.data.deviceId, parsed.data.expoToken, parsed.data.platform);
    return { ok: true };
  });

  // Multi-account usage + rotation state.
  app.get("/accounts", async (_req, reply) => {
    try {
      return await accounts.snapshot();
    } catch (err) {
      // cswap missing/misconfigured shouldn't 500 the app — report it softly.
      return reply.code(200).send({
        activeAccountNumber: null,
        accounts: [],
        rotation: { enabled: false, threshold: 0, cooldownMs: 0, lastSwitchAt: null, lastHoldReason: String(err) },
        usageConfigured: usage.configured,
        usageConnectedEmails: usage.connectedEmails(),
      });
    }
  });

  app.post("/accounts/switch", async (req, reply) => {
    const parsed = SwitchAccountRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    return accounts.manualSwitch(parsed.data.to);
  });

  // Connect a claude.ai usage session key (pasted from web/phone, or already
  // extracted). Validates + auto-resolves org/email so the % starts showing.
  app.post("/accounts/usage-key", async (req, reply) => {
    const parsed = ConnectUsageKeyRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    try {
      // Step 2: an org was chosen — persist it.
      if (parsed.data.orgId) {
        const hint = parsed.data.email ?? (await accounts.activeEmail());
        const id = await usage.addKey(parsed.data.sessionKey, parsed.data.orgId, hint);
        return { ok: true, email: id.email, orgId: id.orgId, usage: id.usage, orgs: [], message: null };
      }
      // Step 1: no org yet — return the orgs to pick from (nothing persisted).
      const { email, orgs } = await usage.listOrgs(parsed.data.sessionKey);
      return { ok: false, email, orgId: null, usage: null, orgs, message: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : "could not connect usage key";
      logger.warn("usage key connect failed", { err: message });
      return reply.code(200).send({ ok: false, email: null, orgId: null, usage: null, orgs: [], message });
    }
  });

  // Register a brand-new coding account from a `claude setup-token` value (or
  // a plain API key) — distinct from /accounts/usage-key, which only ever
  // connects a read-only claude.ai usage session key.
  app.post("/accounts/setup-token", async (req, reply) => {
    const parsed = AddSetupTokenRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    return accounts.addSetupToken(parsed.data.token);
  });

  // Remove a previously-connected usage key (e.g. the wrong org got picked).
  app.delete<{ Params: { email: string } }>("/accounts/usage-key/:email", async (req, reply) => {
    const ok = usage.removeKey(req.params.email);
    return { ok };
  });

  // Guided browser login: daemon opens a browser on its own host, user signs
  // in, we read the cookie. Returns { unavailable: true } if Playwright/Chrome
  // isn't installed, or if that host has no display to render the browser on.
  app.post("/accounts/usage-key/login", async (_req, reply) => {
    try {
      const sessionKey = await loginAndExtractSessionKey({
        baseUrl: config.usageBaseUrl,
        channel: config.usageLoginChannel || undefined,
        timeoutMs: config.usageLoginTimeoutMs,
      });
      // Return the orgs to pick from + the key, so the web client completes the
      // pick with a follow-up connect call. Nothing is persisted yet.
      const { email, orgs } = await usage.listOrgs(sessionKey);
      return { ok: false, email, usage: null, orgs, sessionKey, message: null, unavailable: false };
    } catch (err) {
      if (err instanceof PlaywrightUnavailableError) {
        return reply
          .code(200)
          .send({ ok: false, email: null, usage: null, orgs: [], sessionKey: null, message: err.message, unavailable: true });
      }
      const message = err instanceof Error ? err.message : "guided login failed";
      logger.warn("usage guided login failed", { err: message });
      return reply
        .code(200)
        .send({ ok: false, email: null, usage: null, orgs: [], sessionKey: null, message, unavailable: false });
    }
  });

  // ── WebSocket (plugin registered above, before the auth hook) ─────────────
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
      const conn = new Connection(socket, deviceId, deviceName, manager, broker, devices, () => liveConnections.delete(conn));
      liveConnections.add(conn);
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
    const status =
      err.code === "session_not_found" || err.code === "repo_not_found"
        ? 404
        : err.code === "invalid_request"
          ? 400
          : 409;
    return reply.code(status).send({ error: err.code, message: err.message });
  }
  logger.error("request failed", { err: err instanceof Error ? err.stack : String(err) });
  return reply.code(500).send({ error: "internal" });
}
