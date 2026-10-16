import { describe, expect, it } from "vitest";
import { createHomelabGuardHook, homelabAllowed, homelabCommandReason, parseHomelabRepos } from "../src/claude/homelabGuard.js";

describe("parseHomelabRepos / homelabAllowed", () => {
  it("is not enforced when unset, and nobody when set but empty", () => {
    expect(parseHomelabRepos(undefined)).toBeNull();
    expect(parseHomelabRepos("")).toEqual([]);
    expect(homelabAllowed(null, "about-me", "about-me")).toBe(true);
    expect(homelabAllowed(undefined, "about-me", "about-me")).toBe(true);
    expect(homelabAllowed([], "renki", "renki")).toBe(false);
  });

  it("matches repo id or name, case-insensitively, and @plain for repo-less sessions", () => {
    const allowed = parseHomelabRepos(" Renki, talkoot ,@plain");
    expect(allowed).toEqual(["renki", "talkoot", "@plain"]);
    expect(homelabAllowed(allowed, "renki", "renki")).toBe(true);
    expect(homelabAllowed(allowed, "r_1", "Talkoot")).toBe(true);
    expect(homelabAllowed(allowed, "about-me", "about-me")).toBe(false);
    expect(homelabAllowed(allowed, null, "No repo")).toBe(true);
    expect(homelabAllowed(["renki"], null, "No repo")).toBe(false);
  });
});

describe("homelabCommandReason", () => {
  it("catches the command however it is dressed up", () => {
    for (const cmd of [
      "homelab status",
      "  homelab deploy talkoot",
      "cd /tmp && homelab logs talkoot",
      "echo hi; homelab top",
      "true || homelab restart x",
      "FOO=1 homelab status",
      "sudo homelab rm-path /x",
      "env -i homelab status",
      "/usr/local/bin/homelab status",
      "(homelab status)",
      "echo $(homelab status)",
      "echo `homelab status`",
      "bash -c \"homelab deploy talkoot\"",
      "sh -c 'homelab status'",
      "ssh -i /gateway/renki_key homelab-gw@homelab-host status",
      "cat /gateway/renki_key",
      "ssh homelab-gw@localhost deploy x",
      "ls\nhomelab status",
    ]) {
      expect(homelabCommandReason(cmd), cmd).not.toBeNull();
    }
  });

  it("leaves ordinary commands that merely mention the word alone", () => {
    for (const cmd of [
      "git commit -m 'document the homelab setup'",
      "git commit -m \"homelab\"",
      "grep -rn homelab docs/",
      "cat docs/homelab-gateway.md",
      "echo homelab",
      "ls ~/homelab-notes",
      "npm test",
      "cd ops/homelab-gateway && python3 -m unittest",
      "ssh homelab 'uptime'",
    ]) {
      expect(homelabCommandReason(cmd), cmd).toBeNull();
    }
  });
});

describe("createHomelabGuardHook", () => {
  const hook = createHomelabGuardHook();
  const run = (tool_name: string, tool_input: unknown) =>
    hook.hooks[0]!({ hook_event_name: "PreToolUse", tool_name, tool_input, session_id: "s", transcript_path: "", cwd: "/" } as never, undefined, {
      signal: new AbortController().signal,
    });

  it("denies a homelab call with a reason that tells Claude to stop and ask", async () => {
    const out = (await run("Bash", { command: "homelab deploy talkoot" })) as { hookSpecificOutput: Record<string, string> };
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/doesn't have homelab access/);
  });

  it("lets everything else through, including malformed input", async () => {
    expect(await run("Bash", { command: "npm test" })).toEqual({ continue: true });
    expect(await run("Bash", {})).toEqual({ continue: true });
    expect(await run("Bash", null)).toEqual({ continue: true });
    expect(await run("Read", { command: "homelab status" })).toEqual({ continue: true });
  });
});
