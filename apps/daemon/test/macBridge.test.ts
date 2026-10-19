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
    expect(s.sent).toEqual([]);
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
