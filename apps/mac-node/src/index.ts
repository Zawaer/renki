import { DaemonToMac, type MacToDaemon } from "@renki/protocol";
import { Adb, saveResponse } from "./adb.js";
import { loadConfig } from "./config.js";

/**
 * Renki Mac agent: dials out to the daemon's `/mac/ws` and runs the phone
 * verbs it is sent (./adb.ts), as long as this process lives. The menu bar app
 * (macos/RenkiMac.swift) starts and stops it; that is the on/off switch.
 *
 * stdout carries one JSON status line per change, for the menu bar:
 *   {"state":"connecting"|"connected"|"offline"|"error","detail":"…"}
 *   {"call":"screenshot","phase":"start"|"end","ok":true}
 * Human-readable logs go to stderr.
 */

const VERSION = "0.1.0";
const SILENT_LIMIT_MS = 70_000;

const config = loadConfig();
const auth = { authorization: `Bearer ${config.token}` };

const adb = new Adb({
  adb: config.adb,
  download: async (fileId, dest) => saveResponse(await fetch(`${config.url}/mac/files/${encodeURIComponent(fileId)}`, { headers: auth }), dest),
});

function status(obj: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
function log(msg: string): void {
  process.stderr.write(`${new Date().toISOString()} ${msg}\n`);
}

let socket: WebSocket | null = null;
let lastHeard = 0;
let backoffMs = 1000;
let retry: NodeJS.Timeout | null = null;
let stopping = false;

function scheduleReconnect(ms: number): void {
  if (stopping || retry) return;
  retry = setTimeout(() => {
    retry = null;
    void connect();
  }, ms);
}

async function connect(): Promise<void> {
  status({ state: "connecting", detail: config.url });
  // Ask over plain HTTP first: a WebSocket that fails tells us nothing about why.
  try {
    const res = await fetch(`${config.url}/mac`, { headers: auth, signal: AbortSignal.timeout(10_000) });
    if (res.status === 401) {
      status({ state: "error", detail: "Renki rejected the token. Check mac-node.json." });
      return scheduleReconnect(60_000);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    status({ state: "offline", detail: `Can't reach Renki (${err instanceof Error ? (err.cause as Error | undefined)?.message ?? err.message : String(err)})` });
    backoffMs = Math.min(backoffMs * 2, 30_000);
    return scheduleReconnect(backoffMs);
  }

  const ws = new WebSocket(`${config.url.replace(/^http/, "ws")}/mac/ws?token=${encodeURIComponent(config.token)}`);
  socket = ws;
  const send = (msg: MacToDaemon) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  ws.addEventListener("open", () => {
    lastHeard = Date.now();
    backoffMs = 1000;
    send({ type: "hello", name: config.name, version: VERSION, verbs: config.verbs });
    status({ state: "connected", detail: `${config.name} → ${new URL(config.url).host}`, verbs: config.verbs });
    log(`connected to ${config.url} as ${config.name}; verbs: ${config.verbs.join(", ")}`);
  });

  ws.addEventListener("message", (ev) => {
    lastHeard = Date.now();
    let msg: DaemonToMac;
    try {
      msg = DaemonToMac.parse(JSON.parse(String(ev.data)));
    } catch {
      log("ignored a message that isn't a known call");
      return;
    }
    if (msg.type === "ping") return send({ type: "pong" });

    const { id, verb, args } = msg;
    if (!config.verbs.includes(verb)) {
      return send({ type: "result", id, ok: false, text: `"${verb}" is switched off on this Mac.` });
    }
    status({ call: verb, phase: "start" });
    log(`${verb} ${verb === "shell" ? JSON.stringify(args) : ""}`.trim());
    void adb.run(verb, args).then((r) => {
      status({ call: verb, phase: "end", ok: r.ok });
      if (!r.ok) log(`${verb} failed: ${r.text.slice(0, 300)}`);
      send({ type: "result", id, ok: r.ok, text: r.text, ...(r.image ? { image: r.image } : {}) });
    });
  });

  ws.addEventListener("close", (ev) => {
    if (socket !== ws) return;
    socket = null;
    if (stopping) return;
    status({ state: "offline", detail: ev.reason || `disconnected (${ev.code})` });
    log(`disconnected: ${ev.code} ${ev.reason}`);
    scheduleReconnect(ev.code === 4000 ? 5_000 : backoffMs);
  });
  ws.addEventListener("error", () => {
    // `close` follows and handles the retry.
  });
}

// The daemon pings every 25s. Hearing nothing for longer (the Mac slept, the
// network changed) means the socket is dead even if it never closed.
setInterval(() => {
  if (socket && socket.readyState === WebSocket.OPEN && Date.now() - lastHeard > SILENT_LIMIT_MS) {
    log("no word from Renki for a while; reconnecting");
    const dead = socket;
    socket = null;
    dead.close();
    status({ state: "offline", detail: "lost the connection" });
    scheduleReconnect(1000);
  }
}, 10_000);

function shutdown(): void {
  stopping = true;
  socket?.close(1000, "switched off on the Mac");
  setTimeout(() => process.exit(0), 300);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

void connect();
