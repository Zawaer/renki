import { basename } from "node:path";
import { DaemonToMac, MacVerbArgs, type MacToDaemon } from "@renki/protocol";
import { Adb, type Result, saveResponse } from "./adb.js";
import { watch } from "node:fs";
import { CONFIG_PATH, jobInfo, loadConfig } from "./config.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Runner, putFile } from "./runner.js";
import { Serial } from "./serial.js";
import { BuildVm, MAC_FROM_VM } from "./vm.js";

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

const download = async (fileId: string, dest: string) =>
  saveResponse(await fetch(`${config.url}/mac/files/${encodeURIComponent(fileId)}`, { headers: auth }), dest);
const serial = config.espPython ? new Serial({ python: config.espPython, download }) : null;
const SERIAL_VERBS = new Set(["serial_ports", "serial_read", "esp_reset", "esp_flash"]);

/** A serial call, checked against the shared schemas here on the Mac, whatever the daemon sent. */
function runSerial(verb: "serial_ports" | "serial_read" | "esp_reset" | "esp_flash", args: unknown): Promise<Result> {
  const parsed = MacVerbArgs[verb].safeParse(args);
  if (!parsed.success || !serial) return Promise.resolve({ ok: false, text: `Refused by the Mac: bad arguments for ${verb}.` });
  return serial.run(verb, parsed.data);
}

const daemonUrl = new URL(config.url);
// The Dockerfile and renki-runner.mjs, next to this script (dist/ or the app's Resources/).
const imageDir = process.env.RENKI_RUNNER_IMAGE ?? join(dirname(fileURLToPath(import.meta.url)), "runner-image");
const vm = config.runner ? new BuildVm(config.runner, imageDir, log) : null;
const runner = vm
  ? new Runner(
      config,
      { wrapper: vm.wrapper, ensure: () => vm.ensure(), stop: () => vm.stop(), macAddress: MAC_FROM_VM },
      {
        fetchFiles: async (jobId, paths) => {
          const res = await fetch(`${config.url}/mac/jobs/${encodeURIComponent(jobId)}/files`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ paths }),
          });
          if (!res.ok) throw new Error(`fetching files failed (HTTP ${res.status})`);
          return Buffer.from(await res.arrayBuffer());
        },
        upload: (jobId, name, file) => putFile(`${config.url}/mac/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(name)}`, auth, file),
        host: daemonUrl.hostname,
        port: Number(daemonUrl.port) || (daemonUrl.protocol === "https:" ? 443 : 80),
      },
      (apk, serial) => adb.installLocal(apk, basename(apk), serial),
    )
  : null;

function status(obj: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
function log(msg: string): void {
  process.stderr.write(`${new Date().toISOString()} ${msg}\n`);
}

let socket: WebSocket | null = null;

/**
 * Builds by call id. A build outlives the connection it came on (the Mac
 * slept, the network changed): its progress and result go to whichever
 * connection is current, and its result is kept a while in case that one was
 * already dead. On reconnecting, the daemon says which builds it still wants
 * (`awaiting`); the others are stopped, since nobody will read their result.
 */
const builds = new Map<string, { abort: AbortController; result: MacToDaemon | null }>();
const KEEP_RESULT_MS = 30 * 60_000;

function sendNow(msg: MacToDaemon): void {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

function onAwaiting(ids: string[]): void {
  for (const [id, b] of builds) {
    if (ids.includes(id)) {
      if (b.result) sendNow(b.result);
      continue;
    }
    builds.delete(id);
    if (!b.result) {
      log(`stopping build ${id.slice(0, 8)}: Renki no longer waits for it`);
      b.abort.abort();
    }
  }
}

function startBuild(id: string, args: unknown): Promise<Result> {
  const parsed = MacVerbArgs.run.safeParse(args);
  if (!parsed.success || !runner) return Promise.resolve({ ok: false, text: "Refused by the Mac: bad build job request." });
  const abort = new AbortController();
  builds.set(id, { abort, result: null });
  return runner.run(parsed.data, progressSender(id, sendNow), abort.signal);
}
function sendHello(): void {
  sendNow({ type: "hello", name: config.name, version: VERSION, verbs: config.verbs, ...(runner ? { jobs: jobInfo(config) } : {}) });
}

/**
 * Pick up jobs added to (or changed in) mac-node.json without a restart, so
 * adding one is just an edit. Only the jobs, and the verbs that follow from
 * them, change in place: a build already running keeps the job it started
 * with, and the daemon takes a second hello as the new list. Anything else
 * (url, token, the VM) still needs the agent restarted. A file that doesn't
 * parse is reported and ignored, keeping the jobs that work.
 */
function watchJobs(): void {
  let timer: NodeJS.Timeout | null = null;
  const reload = () => {
    timer = null;
    let next: ReturnType<typeof loadConfig>;
    try {
      next = loadConfig();
    } catch (err) {
      log(`mac-node.json changed but can't be used, keeping the old jobs: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (JSON.stringify(next.jobs) === JSON.stringify(config.jobs)) return;
    config.jobs = next.jobs;
    config.verbs = next.verbs;
    log(`reloaded jobs from mac-node.json: ${Object.entries(config.jobs).map(([p, j]) => `${p} (${Object.keys(j).join(", ")})`).join("; ") || "none"}`);
    sendHello();
  };
  // Watch the folder, not the file: editors save by replacing it, which ends a watch on the file itself.
  watch(dirname(CONFIG_PATH), (_event, name) => {
    if (name !== basename(CONFIG_PATH)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(reload, 500);
  }).unref();
}

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
    sendHello();
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
    if (msg.type === "awaiting") return onAwaiting(msg.ids);

    const { id, verb, args } = msg;
    if (!config.verbs.includes(verb)) {
      return send({ type: "result", id, ok: false, text: `"${verb}" is switched off on this Mac.` });
    }
    status({ call: verb, phase: "start" });
    log(`${verb} ${verb === "shell" ? JSON.stringify(args) : ""}`.trim());
    const work: Promise<Result> =
      verb === "run"
        ? startBuild(id, args)
        : SERIAL_VERBS.has(verb)
          ? runSerial(verb as "serial_ports" | "serial_read" | "esp_reset" | "esp_flash", args)
          : adb.run(verb, args);
    void work.then((r) => {
      status({ call: verb, phase: "end", ok: r.ok });
      if (!r.ok) log(`${verb} failed: ${r.text.slice(0, 300)}`);
      const result: MacToDaemon = { type: "result", id, ok: r.ok, text: r.text, ...(r.image ? { image: r.image } : {}) };
      if (verb !== "run") return send(result);
      const b = builds.get(id);
      if (!b) return; // stopped: nobody is waiting
      b.result = result;
      sendNow(result);
      setTimeout(() => builds.delete(id), KEEP_RESULT_MS).unref();
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

/**
 * Progress for one call, as the daemon wants it: a phase change goes at once,
 * a newer log line at most every few seconds (the latest one wins).
 */
function progressSender(id: string, send: (msg: MacToDaemon) => void): (phase: string, detail?: string) => void {
  let phase = "";
  let sentAt = 0;
  let pending: NodeJS.Timeout | null = null;
  let latest: string | undefined;
  const flush = () => {
    pending = null;
    sentAt = Date.now();
    send({ type: "progress", id, phase, ...(latest ? { detail: latest } : {}) });
  };
  return (p, detail) => {
    latest = detail;
    if (p !== phase) {
      phase = p;
      if (pending) clearTimeout(pending);
      return flush();
    }
    if (!pending) pending = setTimeout(flush, Math.max(0, 3_000 - (Date.now() - sentAt)));
  };
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
  serial?.stopAll();
  // Switched off: the build VM stops too, and everything in it.
  void Promise.race([runner?.stop(), new Promise((r) => setTimeout(r, 60_000))]).then(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

watchJobs();
void connect();
