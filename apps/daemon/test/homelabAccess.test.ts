import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HomelabAccess } from "../src/claude/homelabAccess.js";
import { createHomelabGuardHook } from "../src/claude/homelabGuard.js";

describe("HomelabAccess", () => {
  it("starts from the environment, then keeps what Settings saves", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "access-"));
    expect(new HomelabAccess(dir, ["talkoot"]).get()).toEqual(["talkoot"]);
    const a = new HomelabAccess(dir, ["talkoot"]);
    expect(a.set(["Matka", "matka", " pihi ", "@plain"])).toEqual(["@plain", "matka", "pihi"]);
    expect(new HomelabAccess(dir, ["talkoot"]).get()).toEqual(["@plain", "matka", "pihi"]);
    a.set(null);
    expect(a.get()).toBeNull();
  });

  it("fails closed on a broken file", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "access-"));
    writeFileSync(resolve(dir, "homelab-access.json"), "{nope");
    expect(new HomelabAccess(dir, null).get()).toEqual([]);
  });
});

describe("homelab guard", () => {
  const run = (blocked: () => boolean, command: string) =>
    createHomelabGuardHook(blocked).hooks[0]!(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } } as never,
      undefined,
      { signal: new AbortController().signal },
    );

  it("asks on every command, so a change applies to a running chat", async () => {
    let blocked = true;
    expect(await run(() => blocked, "homelab add-app life-api")).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    blocked = false;
    expect(await run(() => blocked, "homelab add-app life-api")).toEqual({ continue: true });
  });
});
