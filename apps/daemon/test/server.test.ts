import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { AccountRotator } from "../src/accounts/rotator.js";
import { UsageReader } from "../src/accounts/usage.js";
import type { Config } from "../src/config.js";
import { DeviceRegistry } from "../src/push/devices.js";
import { PushTokenStore } from "../src/push/tokens.js";
import { SessionManager } from "../src/sessions/manager.js";
import { createServer } from "../src/server/http.js";
import { PermissionBroker } from "../src/server/permissions.js";
import { cleanupConfig, makeTestConfig, makeTestDb, makeTestRepo } from "./helpers.js";

/**
 * Server integration tests: stand up the real Fastify + WebSocket server
 * in-process and drive it over a real socket — REST auth/CRUD, and the WS
 * subscribe -> replay -> live handoff every client actually depends on.
 *
 * No live `claude`: "live" events are appended directly to the event log
 * (`manager.events.append`), exactly how a real turn would emit them — same
 * trick session-manager.test.ts uses to exercise the log without spawning a
 * process.
 */

const configs: Config[] = [];
const servers: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of servers.splice(0)) await app.close();
  for (const c of configs.splice(0)) cleanupConfig(c);
});

async function startServer() {
  const config = makeTestConfig();
  configs.push(config);
  const { repoId } = makeTestRepo(config.reposRoot);
  const db = makeTestDb();
  const manager = new SessionManager(config, db);
  const broker = new PermissionBroker(config.permissionTimeoutMs);
  const devices = new DeviceRegistry();
  const pushTokens = new PushTokenStore(db);
  const usage = new UsageReader(config.usageConfigPath, config.usageBaseUrl);
  const accounts = new AccountRotator(config, manager, usage);

  const app = await createServer(config, { manager, broker, pushTokens, devices, accounts, usage });
  await app.listen({ port: 0, host: "127.0.0.1" });
  servers.push(app);

  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  return {
    base: `http://127.0.0.1:${address.port}`,
    wsBase: `ws://127.0.0.1:${address.port}`,
    manager,
    config,
    repoId,
  };
}

function authedFetch(base: string, token: string) {
  return (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } });
}

describe("REST: auth", () => {
  it("allows /health with no token", async () => {
    const { base } = await startServer();
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it("rejects everything else with no or the wrong token", async () => {
    const { base } = await startServer();
    expect((await fetch(`${base}/repos`)).status).toBe(401);
    expect((await fetch(`${base}/repos`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  });

  it("accepts the configured token via Bearer, x-crc-token, or ?token=", async () => {
    const { base, config } = await startServer();
    expect((await fetch(`${base}/repos`, { headers: { authorization: `Bearer ${config.authToken}` } })).status).toBe(200);
    expect((await fetch(`${base}/repos`, { headers: { "x-crc-token": config.authToken } })).status).toBe(200);
    expect((await fetch(`${base}/repos?token=${config.authToken}`)).status).toBe(200);
  });
});

describe("REST: sessions CRUD", () => {
  it("creates, lists, fetches the transcript, and archives a session", async () => {
    const { base, config, repoId } = await startServer();
    const authed = authedFetch(base, config.authToken);

    const createRes = await authed("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId, baseBranch: "main" }),
    });
    expect(createRes.status).toBe(201);
    const { session } = await createRes.json();
    expect(session.repoId).toBe(repoId);
    expect(session.status).toBe("idle");

    const list = await (await authed("/sessions")).json();
    expect(list.sessions.map((s: { id: string }) => s.id)).toContain(session.id);

    const transcript = await (await authed(`/sessions/${session.id}/transcript`)).json();
    expect(transcript.events.map((e: { kind: string }) => e.kind)).toEqual(["session_created", "status_changed"]);

    const archiveRes = await authed(`/sessions/${session.id}/archive`, { method: "POST" });
    expect(archiveRes.status).toBe(200);
    expect((await archiveRes.json()).session.status).toBe("archived");
  });

  it("404s creating a session against an unknown repo", async () => {
    const { base, config } = await startServer();
    const res = await authedFetch(base, config.authToken)("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "ghost", baseBranch: "main" }),
    });
    expect(res.status).toBe(404);
  });

  it("400s an invalid create-session body", async () => {
    const { base, config } = await startServer();
    const res = await authedFetch(base, config.authToken)("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "" }),
    });
    expect(res.status).toBe(400);
  });
});

type Msg = Record<string, unknown>;

/**
 * Buffers every message a socket receives from the moment it's created.
 *
 * A naive "attach a listener, remove it once matched, attach the next one on
 * the next await" approach loses messages: `subscribed` and `replay` are sent
 * synchronously back-to-back by the server, so both can arrive in the same
 * tick — if the listener for `replay` isn't attached until after the
 * `subscribed` listener's promise resolves (a microtask later), `replay`
 * fires into an empty listener set and is silently lost. Buffering up front
 * and matching against already-received messages first avoids that race.
 */
class MessageBus {
  private readonly buffered: Msg[] = [];
  private readonly waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];

  constructor(ws: WebSocket) {
    ws.on("message", (raw: Buffer) => {
      const msg = JSON.parse(raw.toString());
      const i = this.waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(msg);
      else this.buffered.push(msg);
    });
  }

  next(pred: (m: Msg) => boolean, timeoutMs = 2000): Promise<Msg> {
    const i = this.buffered.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.buffered.splice(i, 1)[0]!);
    return new Promise((resolve, reject) => {
      const entry = {
        pred,
        resolve: (m: Msg) => {
          clearTimeout(timer);
          resolve(m);
        },
      };
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(entry);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error("timed out waiting for a matching message"));
      }, timeoutMs);
      this.waiters.push(entry);
    });
  }
}

function connectWs(wsBase: string, query: string): Promise<{ ws: WebSocket; bus: MessageBus }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/ws?${query}`);
    const bus = new MessageBus(ws); // attached before 'open' so nothing is missed
    ws.once("open", () => resolve({ ws, bus }));
    ws.once("error", reject);
    // A rejected upgrade (e.g. a bad token, checked in the same onRequest hook
    // as REST) arrives as a normal HTTP response, not a socket error — `ws`
    // surfaces that as `unexpected-response`. The response's socket is left
    // for the caller to deal with; destroy it or app.close() hangs waiting
    // for the connection to end.
    ws.once("unexpected-response", (_req, res) => {
      res.socket?.destroy();
      reject(new Error(`unexpected response: ${res.statusCode}`));
    });
  });
}

async function subscribe(ws: WebSocket, bus: MessageBus, sessionId: string) {
  ws.send(JSON.stringify({ type: "subscribe", sessionId, lastSeq: -1 }));
  await bus.next((m) => m.type === "subscribed");
  return bus.next((m) => m.type === "replay");
}

describe("WebSocket: connection", () => {
  it("closes the upgrade with 1008 when deviceId is missing", async () => {
    const { wsBase, config } = await startServer();
    const ws = new WebSocket(`${wsBase}/ws?token=${config.authToken}`);
    const [code] = await new Promise<[number, Buffer]>((resolve) => ws.once("close", (c, r) => resolve([c, r])));
    expect(code).toBe(1008);
  });

  it("rejects the upgrade with no valid token", async () => {
    const { wsBase } = await startServer();
    await expect(connectWs(wsBase, "deviceId=d1&token=wrong")).rejects.toThrow();
  });
});

describe("WebSocket: subscribe -> replay -> live", () => {
  it("replays existing events then streams new ones live", async () => {
    const { wsBase, config, manager, repoId } = await startServer();
    const session = await manager.createSession({ repoId, baseBranch: "main" });

    const { ws, bus } = await connectWs(wsBase, `deviceId=d1&token=${config.authToken}`);
    const replay = await subscribe(ws, bus, session.id);
    expect(replay.events).toMatchObject([{ kind: "session_created" }, { kind: "status_changed" }]);

    // No live `claude` turn — append directly, exactly as runTurn's `emit` would.
    manager.events.append(session.id, { kind: "notice", text: "hello live", level: "info" });
    const live = await bus.next((m) => m.type === "event");
    expect(live.event).toMatchObject({ kind: "notice", text: "hello live" });

    ws.close();
  });

  it("take_control / release_control broadcast control_changed to subscribers", async () => {
    const { wsBase, config, manager, repoId } = await startServer();
    const session = await manager.createSession({ repoId, baseBranch: "main" });

    const { ws, bus } = await connectWs(wsBase, `deviceId=d1&token=${config.authToken}`);
    await subscribe(ws, bus, session.id);

    ws.send(JSON.stringify({ type: "take_control", sessionId: session.id }));
    const taken = await bus.next((m) => m.type === "event" && (m.event as { kind: string }).kind === "control_changed");
    expect(taken.event).toMatchObject({ controller: "d1" });

    ws.send(JSON.stringify({ type: "release_control", sessionId: session.id }));
    const released = await bus.next(
      (m) => m.type === "event" && (m.event as { controller: string | null }).controller === null,
    );
    expect(released.event).toMatchObject({ kind: "control_changed", controller: null });

    ws.close();
  });

  it("stops delivering events after unsubscribe", async () => {
    const { wsBase, config, manager, repoId } = await startServer();
    const session = await manager.createSession({ repoId, baseBranch: "main" });

    const { ws, bus } = await connectWs(wsBase, `deviceId=d1&token=${config.authToken}`);
    await subscribe(ws, bus, session.id);

    ws.send(JSON.stringify({ type: "unsubscribe", sessionId: session.id }));
    await new Promise((r) => setTimeout(r, 50)); // no ack for unsubscribe by design

    manager.events.append(session.id, { kind: "notice", text: "should not arrive", level: "info" });
    await expect(bus.next((m) => m.type === "event", 300)).rejects.toThrow();

    ws.close();
  });

  it("rejects submit_prompt from a non-controller over the socket", async () => {
    const { wsBase, config, manager, repoId } = await startServer();
    const session = await manager.createSession({ repoId, baseBranch: "main" });

    const { ws, bus } = await connectWs(wsBase, `deviceId=d1&token=${config.authToken}`);
    await subscribe(ws, bus, session.id);

    ws.send(JSON.stringify({ type: "submit_prompt", sessionId: session.id, promptId: "p1", text: "hi" }));
    const err = await bus.next((m) => m.type === "error");
    expect(err).toMatchObject({ code: "not_controller" });

    ws.close();
  });

  it("a reconnecting device replays only what it missed via lastSeq", async () => {
    const { wsBase, config, manager, repoId } = await startServer();
    const session = await manager.createSession({ repoId, baseBranch: "main" });
    manager.events.append(session.id, { kind: "notice", text: "first", level: "info" });

    const { ws: ws1, bus: bus1 } = await connectWs(wsBase, `deviceId=d1&token=${config.authToken}`);
    const firstReplay = await subscribe(ws1, bus1, session.id);
    const upToSeq = firstReplay.upToSeq as number;
    ws1.close();

    manager.events.append(session.id, { kind: "notice", text: "second", level: "info" });

    // Same device reconnects (e.g. after a network blip) with its last-known seq.
    const { ws: ws2, bus: bus2 } = await connectWs(wsBase, `deviceId=d1&token=${config.authToken}`);
    ws2.send(JSON.stringify({ type: "subscribe", sessionId: session.id, lastSeq: upToSeq }));
    await bus2.next((m) => m.type === "subscribed");
    const replay = await bus2.next((m) => m.type === "replay");
    expect(replay.events).toMatchObject([{ kind: "notice", text: "second" }]);

    ws2.close();
  });
});
