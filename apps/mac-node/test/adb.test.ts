import { describe, expect, it } from "vitest";
import { Adb, type Exec, inputArgv, logcatArgv, parseDevices, pngSize, shQuote } from "../src/adb.js";

function fakeAdb(responses: Record<string, string> = {}) {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    const key = Object.keys(responses).find((k) => args.join(" ").startsWith(k));
    return { stdout: Buffer.from(key ? responses[key]! : ""), stderr: Buffer.alloc(0), code: 0 };
  };
  const adb = new Adb({ adb: "adb", exec, download: async () => {} });
  return { adb, calls };
}

const ONE = "List of devices attached\nabc123\tdevice\n\n";

describe("argv building", () => {
  it("quotes text for the phone's shell, so it can't run a second command", () => {
    expect(shQuote("it's; reboot")).toBe(`'it'\\''s; reboot'`);
    expect(inputArgv({ kind: "text", text: "hi there; reboot" })).toEqual(["shell", "input", "text", "'hi%sthere;%sreboot'"]);
  });

  it("builds taps, swipes and keys from checked values only", () => {
    expect(inputArgv({ kind: "tap", x: 10, y: 20 })).toEqual(["shell", "input", "tap", "10", "20"]);
    expect(inputArgv({ kind: "swipe", x1: 1, y1: 2, x2: 3, y2: 4 })).toEqual(["shell", "input", "swipe", "1", "2", "3", "4", "300"]);
    expect(inputArgv({ kind: "key", key: "BACK" })).toEqual(["shell", "input", "keyevent", "KEYCODE_BACK"]);
    expect(inputArgv({ kind: "key", key: "KEYCODE_HOME" })).toEqual(["shell", "input", "keyevent", "KEYCODE_HOME"]);
  });

  it("silences other tags when tags are given", () => {
    expect(logcatArgv({ tags: ["ReactNativeJS:V"] })).toEqual(["logcat", "-d", "-v", "time", "-t", "300", "ReactNativeJS:V", "*:S"]);
  });

  it("reads devices and PNG sizes", () => {
    expect(parseDevices("List of devices attached\nabc\tdevice\n10.0.0.2:5555\tunauthorized\n")).toEqual({
      ready: ["abc"],
      other: [{ serial: "10.0.0.2:5555", state: "unauthorized" }],
    });
    const png = Buffer.alloc(24);
    png.write("\x89PNG", 0, "latin1");
    png.writeUInt32BE(1080, 16);
    png.writeUInt32BE(2400, 20);
    expect(pngSize(png)).toEqual({ width: 1080, height: 2400 });
    expect(pngSize(Buffer.from("nope"))).toBeNull();
  });
});

describe("Adb.run", () => {
  it("refuses shapes the schemas don't allow, before running anything", async () => {
    const { adb, calls } = fakeAdb({ devices: ONE });
    for (const [verb, args] of [
      ["shell", { command: "ls", extra: 1 }],
      ["screenshot", { serial: "abc; rm -rf ~" }],
      ["logcat", { tags: ["-f /Users/x/file"] }],
      ["input", { action: { kind: "key", key: "BACK; reboot" } }],
      ["install", { fileId: "../../etc", name: "x.apk" }],
    ] as const) {
      const r = await adb.run(verb, args);
      expect(r.ok, verb).toBe(false);
      expect(r.text).toMatch(/^Refused by the Mac/);
    }
    expect(calls).toEqual([]);
  });

  it("targets the only ready phone with -s, and hands a shell command over as one argument", async () => {
    const { adb, calls } = fakeAdb({ devices: ONE, "-s abc123 shell": "ok" });
    const r = await adb.run("shell", { command: "dumpsys battery | head -3" });
    expect(r).toEqual({ ok: true, text: "ok" });
    expect(calls.at(-1)).toEqual(["adb", "-s", "abc123", "shell", "dumpsys battery | head -3"]);
  });

  it("explains what to do when no phone is ready", async () => {
    const { adb } = fakeAdb({ devices: "List of devices attached\nabc\tunauthorized\n" });
    const r = await adb.run("logcat", {});
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/accept the prompt on the phone/);
  });

  it("asks for a serial when two phones are connected", async () => {
    const { adb } = fakeAdb({ devices: "List of devices attached\na\tdevice\nb\tdevice\n" });
    expect((await adb.run("screenshot", {})).text).toMatch(/pass `serial`/);
  });

  it("filters logcat on the Mac and clears only when asked", async () => {
    const { adb, calls } = fakeAdb({ devices: ONE, "-s abc123 logcat -d": "x Foo\ny bar\nz FOO\n" });
    const r = await adb.run("logcat", { grep: "foo", clear: true });
    expect(r.text).toBe("x Foo\nz FOO");
    expect(calls.at(-1)).toEqual(["adb", "-s", "abc123", "logcat", "-c"]);
  });
});
