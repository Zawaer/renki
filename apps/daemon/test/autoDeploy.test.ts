import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AutoDeployer, COOLDOWN_MS, QUIET_MS } from "../src/deploy/autoDeploy.js";

const A = "a".repeat(40);
const B = "b".repeat(40);

function make(over: { build?: string | null; latest?: string | null; busy?: () => number } = {}) {
  let t = 100_000_000;
  const deploy = vi.fn(async () => ({ ok: true, output: "" }));
  const d = new AutoDeployer({
    file: join(mkdtempSync(join(tmpdir(), "ad-")), "auto-deploy.json"),
    buildSha: over.build === undefined ? A : over.build,
    latestSha: async () => (over.latest === undefined ? B : over.latest),
    busyCount: over.busy ?? (() => 0),
    deploy,
    now: () => t,
  });
  return { d, deploy, advance: (ms: number) => (t += ms) };
}

describe("AutoDeployer", () => {
  it("does nothing while off", async () => {
    const { d, deploy, advance } = make();
    await d.check();
    advance(QUIET_MS + 1);
    await d.check();
    expect(deploy).not.toHaveBeenCalled();
    expect(d.status().pending).toBe(true);
  });

  it("deploys only after a quiet window", async () => {
    const { d, deploy, advance } = make();
    d.setEnabled(true);
    await new Promise((r) => setTimeout(r, 0));
    await d.check();
    expect(deploy).not.toHaveBeenCalled();
    advance(QUIET_MS + 1);
    await d.check();
    expect(deploy).toHaveBeenCalledOnce();
  });

  it("waits while a chat is running and restarts the quiet window", async () => {
    let busy = 1;
    const { d, deploy, advance } = make({ busy: () => busy });
    d.setEnabled(true);
    await new Promise((r) => setTimeout(r, 0));
    await d.check();
    advance(QUIET_MS * 3);
    await d.check();
    expect(deploy).not.toHaveBeenCalled();
    busy = 0;
    await d.check();
    advance(QUIET_MS - 1000);
    await d.check();
    expect(deploy).not.toHaveBeenCalled();
  });

  it("does nothing when the build commit is unknown or main is the same", async () => {
    const unknown = make({ build: null });
    unknown.d.setEnabled(true);
    await new Promise((r) => setTimeout(r, 0));
    unknown.advance(QUIET_MS * 2);
    await unknown.d.check();
    expect(unknown.deploy).not.toHaveBeenCalled();
    const same = make({ latest: A });
    same.d.setEnabled(true);
    await new Promise((r) => setTimeout(r, 0));
    await same.d.check();
    same.advance(QUIET_MS * 2);
    await same.d.check();
    expect(same.deploy).not.toHaveBeenCalled();
  });

  it("doesn't retry inside the cooldown", async () => {
    const { d, deploy, advance } = make();
    d.setEnabled(true);
    await new Promise((r) => setTimeout(r, 0));
    await d.check();
    advance(QUIET_MS + 1);
    await d.check();
    advance(QUIET_MS + 1);
    await d.check();
    expect(deploy).toHaveBeenCalledOnce();
    advance(COOLDOWN_MS);
    await d.check();
    expect(deploy).toHaveBeenCalledTimes(2);
  });
});
