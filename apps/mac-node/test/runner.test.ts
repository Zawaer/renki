import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { Runner, type RunWrapper } from "../src/runner.js";

const config: Config = {
  url: "https://renki.internal/api",
  token: "t",
  name: "Mac",
  adb: "adb",
  verbs: ["run"],
  runner: { profile: "renki-runner", cpus: 2, memoryGb: 4, diskGb: 40, colima: "colima", docker: "docker" },
  jobs: {
    matka: {
      build: { description: "", command: "./gradlew assembleDebug", cwd: "mobile", timeoutMinutes: 5, artifacts: ["out/app.apk"], installApk: "out/app.apk" },
    },
  },
};
const manifest = [{ p: "mobile/a.ts", h: "a".repeat(40), x: false }];
const args = (extra: object = {}) => ({ jobId: "j".repeat(20), project: "matka", job: "build", manifest, ...extra });

function setup(probe: object, down: string | null = null) {
  const calls: string[][] = [];
  const uploads: string[] = [];
  const installs: string[] = [];
  const wrapper: RunWrapper = async (a, opts = {}) => {
    calls.push(a);
    const out = (s: string) => ({ code: 0, stdout: Buffer.from(s), stderr: "" });
    switch (a[0]) {
      case "probe":
        return out(JSON.stringify(probe));
      case "diff":
        return out(JSON.stringify(["mobile/a.ts"]));
      case "apply":
        return out("{}");
      case "run":
        opts.onOutput?.(Buffer.from("BUILD SUCCESSFUL\n"));
        return out("");
      case "export":
        writeFileSync(opts.stdoutTo!, "APK");
        return out("");
      default:
        return out("");
    }
  };
  const runner = new Runner(
    config,
    { wrapper, ensure: async () => down, stop: async () => {}, macAddress: "192.168.5.2" },
    { fetchFiles: async () => Buffer.from("frames"), upload: async (_j, name) => (uploads.push(name), `/data/mac-artifacts/s/${name}`), host: "renki.internal", port: 443 },
    async (apk) => (installs.push(apk), { ok: true, text: "Installed." }),
  );
  return { runner, calls, uploads, installs };
}

const CONTAINED = { own: "connected", other: "refused", homelab: "refused", internet: "connected" };

describe("Runner", () => {
  it("refuses to run anything when the firewall doesn't contain the runner", async () => {
    for (const probe of [{ ...CONTAINED, other: "connected" }, { ...CONTAINED, homelab: "connected" }]) {
      const { runner, calls } = setup(probe);
      const r = await runner.run(args());
      expect(r.ok).toBe(false);
      expect(r.text).toMatch(/firewall/);
      expect(calls.map((c) => c[0])).toEqual(["probe"]);
    }
  });

  it("probes how the VM would reach the Mac's localhost, and runs nothing if the VM isn't up", async () => {
    const a = setup(CONTAINED);
    await a.runner.run(args());
    expect(a.calls[0]!.slice(0, 2)).toEqual(["probe", "192.168.5.2"]);
    const b = setup(CONTAINED, "The build VM didn't start");
    expect((await b.runner.run(args())).text).toMatch(/didn't start/);
    expect(b.calls).toEqual([]);
  });

  it("only runs jobs from the Mac's own config, and its own command", async () => {
    const { runner, calls } = setup(CONTAINED);
    expect((await runner.run(args({ job: "rm-rf" }))).text).toMatch(/no job "rm-rf"/);
    expect(calls).toEqual([]);
    await runner.run(args());
    expect(calls.find((c) => c[0] === "run")).toEqual(["run", "matka", "mobile", "300", "./gradlew assembleDebug"]);
  });

  it("syncs, builds, sends the log and artifacts back, and installs only when asked", async () => {
    const a = setup(CONTAINED);
    const r = await a.runner.run(args());
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/succeeded/);
    expect(r.text).toMatch(/BUILD SUCCESSFUL/);
    expect(a.calls.map((c) => c[0])).toEqual(["probe", "diff", "apply", "run", "export"]);
    expect(a.uploads).toEqual(["build.log", "app.apk"]);
    expect(a.installs).toEqual([]);

    const b = setup(CONTAINED);
    expect((await b.runner.run(args({ install: true }))).text).toMatch(/Installed/);
    expect(b.installs).toHaveLength(1);
  });
});

describe("LastLine", () => {
  it("gives the newest complete non-blank line, without colour codes, across chunks", async () => {
    const { LastLine } = await import("../src/runner.js");
    const l = new LastLine();
    expect(l.push(Buffer.from("> Task :app:pre"))).toBeNull();
    expect(l.push(Buffer.from("Build\n\x1b[1m> Task :app:compileDebugKotlin\x1b[0m\n\n"))).toBe("> Task :app:compileDebugKotlin");
    expect(l.push(Buffer.from("50% EXECUTING\r60% EXECUTING\r"))).toBe("60% EXECUTING");
  });
});
