import { randomBytes, randomUUID } from "node:crypto";
import { MacToDaemon, type MacImage, type MacJobInfo, type MacStatus, type MacVerb } from "@renki/protocol";
import type { WebSocket } from "ws";
import { logger } from "../logger.js";

/**
 * The daemon's end of the Mac bridge (see packages/protocol/src/mac.ts).
 *
 * At most one Mac is attached; a newer one replaces the older (the same Mac
 * reconnecting after sleep usually beats its own dead socket's close). A call
 * never rejects: an offline Mac, a timeout or a dropped socket all come back
 * as `ok: false` with a message written for Claude.
 *
 * A build (`run`) survives a dropped connection: it keeps running on the Mac,
 * so its call waits up to RECONNECT_GRACE_MS for the same Mac to come back,
 * then tells it (`awaiting`) which builds are still wanted. The Mac sends the
 * results of those and stops the rest — after a daemon restart, all of them.
 */

export type MacResult = { ok: boolean; text: string; image?: MacImage };

type Attached = { socket: WebSocket; name: string; since: number; verbs: string[]; jobs: Record<string, MacJobInfo[]>; lastHeard: number };
export type MacProgress = { phase: string; detail?: string };
type Pending = {
  socket: WebSocket;
  verb: MacVerb;
  /** The Mac it went to; only that one may pick it up after a reconnect. */
  mac: string;
  settle: (r: MacResult) => void;
  timer: NodeJS.Timeout;
  /** Set while its socket is gone and the call waits for the Mac to reconnect. */
  orphaned?: NodeJS.Timeout;
  onProgress?: (p: MacProgress) => void;
};
type Offer = { path: string; expires: number };

const PING_EVERY_MS = 25_000;
/** A Mac that misses this long is gone (asleep, off the tailnet); its socket may never close by itself. */
const SILENT_LIMIT_MS = 70_000;
const OFFER_TTL_MS = 10 * 60_000;
/** How long a build waits for its Mac to reconnect (sleep, a network change) before it counts as lost. */
const RECONNECT_GRACE_MS = 15 * 60_000;

export const MAC_OFFLINE =
  "The Mac isn't connected to Renki right now, so the phone can't be reached. " +
  "Ask the user to switch on \"Lend this Mac\" in the Renki menu bar on their Mac (with the phone plugged in or paired), then try again.";

export class MacBridge {
  private current: Attached | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly offers = new Map<string, Offer>();
  private readonly pinger: NodeJS.Timeout;

  constructor() {
    this.pinger = setInterval(() => this.keepAlive(), PING_EVERY_MS);
    this.pinger.unref();
  }

  status(): MacStatus {
    const c = this.current;
    const buildsRunning = [...this.pending.values()].filter((p) => p.verb === "run").length;
    return { connected: c !== null, name: c?.name ?? null, since: c?.since ?? null, verbs: c?.verbs ?? [], jobs: c?.jobs ?? {}, buildsRunning };
  }

  /** A freshly upgraded `/mac/ws` socket. It counts as attached once it says hello. */
  attach(socket: WebSocket): void {
    socket.on("message", (raw) => this.onMessage(socket, raw.toString()));
    socket.on("close", () => this.onClose(socket));
    socket.on("error", (err) => logger.warn("mac socket error", { err: String(err) }));
  }

  /** Run one verb on the Mac. `timeoutMs` covers the whole round trip; `onProgress` hears where a long call has got to. */
  call(verb: MacVerb, args: Record<string, unknown>, timeoutMs: number, onProgress?: (p: MacProgress) => void): Promise<MacResult> {
    const c = this.current;
    if (!c) return Promise.resolve({ ok: false, text: MAC_OFFLINE });
    if (!c.verbs.includes(verb)) {
      return Promise.resolve({
        ok: false,
        text: `The Mac (${c.name}) has "${verb}" switched off in its own settings. Tell the user what you wanted to do; don't look for another way.`,
      });
    }
    const id = randomUUID();
    return new Promise<MacResult>((resolve) => {
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        if (p?.orphaned) clearTimeout(p.orphaned);
        this.pending.delete(id);
        resolve({ ok: false, text: `The Mac didn't answer within ${Math.round(timeoutMs / 1000)}s.` });
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { socket: c.socket, verb, mac: c.name, settle: resolve, timer, onProgress });
      c.socket.send(JSON.stringify({ type: "call", id, verb, args }));
    });
  }

  /** Let the Mac download this file once, within OFFER_TTL_MS. Returns the id it asks for. */
  offerFile(path: string): string {
    this.sweepOffers();
    const id = randomBytes(18).toString("base64url");
    this.offers.set(id, { path, expires: Date.now() + OFFER_TTL_MS });
    return id;
  }

  /** The offered file's path, consuming the offer; null when unknown or expired. */
  takeFile(id: string): string | null {
    this.sweepOffers();
    const offer = this.offers.get(id);
    if (!offer) return null;
    this.offers.delete(id);
    return offer.path;
  }

  close(): void {
    clearInterval(this.pinger);
    this.current?.socket.close(1001, "daemon shutting down");
  }

  private onMessage(socket: WebSocket, raw: string): void {
    let parsed: MacToDaemon;
    try {
      parsed = MacToDaemon.parse(JSON.parse(raw));
    } catch {
      logger.warn("mac sent an unrecognised message");
      return;
    }
    if (this.current?.socket === socket) this.current.lastHeard = Date.now();

    switch (parsed.type) {
      case "hello": {
        const previous = this.current;
        this.current = { socket, name: parsed.name, since: Date.now(), verbs: parsed.verbs, jobs: parsed.jobs ?? {}, lastHeard: Date.now() };
        if (previous && previous.socket !== socket) previous.socket.close(4000, "replaced by a newer connection");
        this.adoptBuilds(socket, parsed.name);
        logger.info("mac attached", { name: parsed.name, version: parsed.version, verbs: parsed.verbs, jobs: Object.keys(parsed.jobs ?? {}) });
        return;
      }
      case "result": {
        const p = this.pending.get(parsed.id);
        // Only the socket a call went out on may answer it.
        if (!p || p.socket !== socket) return;
        clearTimeout(p.timer);
        this.pending.delete(parsed.id);
        p.settle({ ok: parsed.ok, text: parsed.text, ...(parsed.image ? { image: parsed.image } : {}) });
        return;
      }
      case "progress": {
        const p = this.pending.get(parsed.id);
        if (!p || p.socket !== socket) return;
        p.onProgress?.({ phase: parsed.phase, ...(parsed.detail ? { detail: parsed.detail } : {}) });
        return;
      }
      case "pong":
        return;
    }
  }

  /** A Mac said hello: its builds that lost their socket continue on this one, and it learns which builds are still wanted. */
  private adoptBuilds(socket: WebSocket, name: string): void {
    const ids: string[] = [];
    for (const [id, p] of this.pending) {
      if (p.verb !== "run" || p.mac !== name) continue;
      if (p.orphaned) clearTimeout(p.orphaned);
      p.orphaned = undefined;
      p.socket = socket;
      ids.push(id);
    }
    socket.send(JSON.stringify({ type: "awaiting", ids }));
  }

  private onClose(socket: WebSocket): void {
    for (const [id, p] of this.pending) {
      if (p.socket !== socket || p.orphaned) continue;
      const fail = (text: string) => {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.settle({ ok: false, text });
      };
      if (p.verb !== "run") {
        fail("The Mac disconnected before it answered.");
        continue;
      }
      p.onProgress?.({ phase: "Waiting for the Mac to reconnect" });
      p.orphaned = setTimeout(
        () => fail(`The Mac disconnected during the build and didn't come back within ${RECONNECT_GRACE_MS / 60_000} minutes.`),
        RECONNECT_GRACE_MS,
      );
      p.orphaned.unref?.();
    }
    if (this.current?.socket === socket) {
      logger.info("mac detached", { name: this.current.name });
      this.current = null;
    }
  }

  private keepAlive(): void {
    const c = this.current;
    if (!c) return;
    if (Date.now() - c.lastHeard > SILENT_LIMIT_MS) {
      logger.info("mac went silent; dropping it", { name: c.name });
      c.socket.terminate();
      this.onClose(c.socket);
      return;
    }
    c.socket.send(JSON.stringify({ type: "ping" }));
  }

  private sweepOffers(): void {
    const now = Date.now();
    for (const [id, o] of this.offers) if (o.expires < now) this.offers.delete(id);
  }
}
