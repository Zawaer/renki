import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { MAC_OFFLINE, MacBridge } from "../src/mac/bridge.js";
import { MAC_ASK_TOOLS, MAC_FREE_TOOLS, createMacApprovalHook } from "../src/mac/tools.js";

class FakeSocket extends EventEmitter {
  sent: any[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.emit("close");
  }
  terminate() {
    this.close();
  }
  /** What the Mac would send. */
  say(msg: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }
}

const hello = (name = "Mac", verbs = ["devices", "screenshot", "shell"]) => ({ type: "hello", name, version: "0.1.0", verbs });

let bridge: MacBridge;
afterEach(() => bridge?.close());

function attach(name?: string, verbs?: string[]) {
  const s = new FakeSocket();
  bridge.attach(s as unknown as WebSocket);
  s.say(hello(name, verbs));
  return s;
}

describe("MacBridge", () => {
  it("answers with how to fix it when no Mac is attached", async () => {
    bridge = new MacBridge();
    expect(bridge.status().connected).toBe(false);
    expect(await bridge.call("devices", {}, 1000)).toEqual({ ok: false, text: MAC_OFFLINE });
  });

  it("only counts a socket as attached once it says hello", async () => {
    bridge = new MacBridge();
    const s = new FakeSocket();
    bridge.attach(s as unknown as WebSocket);
    expect(bridge.status().connected).toBe(false);
    s.say(hello("Toivo's Mac"));
    expect(bridge.status()).toMatchObject({ connected: true, name: "Toivo's Mac", verbs: ["devices", "screenshot", "shell"] });
  });

  /** A build runs while its session is idle; a deploy checking only for busy sessions restarted the daemon under one. */
  it("counts the builds out on the Mac, not other calls", async () => {
    bridge = new MacBridge();
    const s = attach("Mac", ["run", "devices"]);
    const build = bridge.call("run", {}, 1000);
    const { id } = s.sent.at(-1);
    void bridge.call("devices", {}, 1000);
    expect(bridge.status().buildsRunning).toBe(1);
    s.say({ type: "result", id, ok: true, text: "built" });
    await build;
    expect(bridge.status().buildsRunning).toBe(0);
  });

  it("passes a call's progress to its caller, and only from the socket it went out on", async () => {
    bridge = new MacBridge();
    const s = attach("Mac", ["run"]);
    const heard: unknown[] = [];
    const p = bridge.call("run", {}, 1000, (pr) => heard.push(pr));
    const { id } = s.sent.at(-1);
    s.say({ type: "progress", id, phase: "Building", detail: "> Task :app:compileDebugKotlin" });
    const other = new FakeSocket();
    bridge.attach(other as unknown as WebSocket);
    other.say({ type: "progress", id, phase: "Forged" });
    s.say({ type: "progress", id: "unknown", phase: "Nope" });
    s.say({ type: "result", id, ok: true, text: "built" });
    expect(await p).toEqual({ ok: true, text: "built" });
    expect(heard).toEqual([{ phase: "Building", detail: "> Task :app:compileDebugKotlin" }]);
  });

  it("lets a build outlive a dropped connection: the Mac reconnects, hears it's still wanted, and answers there", async () => {
    bridge = new MacBridge();
    const s1 = attach("Mac", ["run", "devices"]);
    expect(s1.sent.at(-1)).toEqual({ type: "awaiting", ids: [] });
    const heard: unknown[] = [];
    const build = bridge.call("run", {}, 60_000, (p) => heard.push(p));
    const { id } = s1.sent.at(-1);
    const shot = bridge.call("devices", {}, 60_000);
    s1.close();
    // A quick call fails at once; the build waits.
    expect(await shot).toEqual({ ok: false, text: "The Mac disconnected before it answered." });
    expect(heard).toEqual([{ phase: "Waiting for the Mac to reconnect" }]);

    const s2 = attach("Mac", ["run", "devices"]);
    expect(s2.sent.at(-1)).toEqual({ type: "awaiting", ids: [id] });
    s1.say({ type: "result", id, ok: true, text: "from the dead socket" });
    s2.say({ type: "result", id, ok: true, text: "built" });
    expect(await build).toEqual({ ok: true, text: "built" });
  });

  it("doesn't hand a build to a different Mac", async () => {
    bridge = new MacBridge();
    const s1 = attach("Mac A", ["run"]);
    void bridge.call("run", {}, 60_000);
    s1.close();
    const s2 = attach("Mac B", ["run"]);
    expect(s2.sent.at(-1)).toEqual({ type: "awaiting", ids: [] });
  });

  it("round-trips a call, and ignores answers from another socket", async () => {
    bridge = new MacBridge();
    const s = attach();
    const p = bridge.call("screenshot", { serial: "abc" }, 1000);
    const sent = s.sent.at(-1);
    expect(sent).toMatchObject({ type: "call", verb: "screenshot", args: { serial: "abc" } });

    const intruder = new FakeSocket();
    bridge.attach(intruder as unknown as WebSocket);
    intruder.say({ type: "result", id: sent.id, ok: true, text: "forged" });

    s.say({ type: "result", id: sent.id, ok: true, text: "shot", image: { mediaType: "image/jpeg", data: "AAAA" } });
    expect(await p).toEqual({ ok: true, text: "shot", image: { mediaType: "image/jpeg", data: "AAAA" } });
  });

  it("doesn't send verbs the Mac switched off", async () => {
    bridge = new MacBridge();
    const s = attach("Mac", ["devices"]);
    const r = await bridge.call("shell", { command: "ls" }, 1000);
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/switched off/);
    expect(s.sent.filter((m) => m.type === "call")).toEqual([]);
  });

  it("fails pending calls when the Mac drops, and a newer Mac replaces an older one", async () => {
    bridge = new MacBridge();
    const first = attach("old");
    const p = bridge.call("devices", {}, 5000);
    const second = attach("new");
    expect(first.closed?.code).toBe(4000);
    expect(await p).toEqual({ ok: false, text: "The Mac disconnected before it answered." });
    expect(bridge.status().name).toBe("new");
    second.close();
    expect(bridge.status().connected).toBe(false);
  });

  /** A build queued behind another on the Mac can wait longer than the timeout; its "waiting" heartbeats keep it alive. */
  it("counts the timeout from the Mac's last progress, not from the call", async () => {
    bridge = new MacBridge();
    const s = attach("Mac", ["run"]);
    const p = bridge.call("run", {}, 60);
    const { id } = s.sent.at(-1);
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 40));
      s.say({ type: "progress", id, phase: "Waiting for another build to finish" });
    }
    s.say({ type: "result", id, ok: true, text: "built" });
    expect(await p).toEqual({ ok: true, text: "built" });
  });

  it("times out a call nobody answers", async () => {
    bridge = new MacBridge();
    attach();
    const r = await bridge.call("devices", {}, 20);
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/didn't answer/);
  });

  it("hands an offered file out once", () => {
    bridge = new MacBridge();
    const id = bridge.offerFile("/repo/app.apk");
    expect(bridge.takeFile("nope")).toBeNull();
    expect(bridge.takeFile(id)).toBe("/repo/app.apk");
    expect(bridge.takeFile(id)).toBeNull();
  });
});

describe("createMacApprovalHook", () => {
  const run = (tool: string) =>
    createMacApprovalHook().hooks[0]!(
      { hook_event_name: "PreToolUse", tool_name: tool, tool_input: {} } as never,
      undefined,
      { signal: new AbortController().signal },
    );

  it("asks before the shell and installs, and stays out of the way otherwise", async () => {
    for (const t of MAC_ASK_TOOLS) expect(await run(t)).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
    for (const t of MAC_FREE_TOOLS) expect(await run(t)).toEqual({ continue: true });
  });
});
