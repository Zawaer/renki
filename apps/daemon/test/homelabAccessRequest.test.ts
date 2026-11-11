import { describe, expect, it } from "vitest";
import { REQUEST_HOMELAB_ACCESS_TOOL, createHomelabAccessHook } from "../src/claude/homelabAccessRequest.js";

const run = (why: unknown) =>
  createHomelabAccessHook(() => "findmy-tag").hooks[0]!(
    { hook_event_name: "PreToolUse", tool_name: REQUEST_HOMELAB_ACCESS_TOOL, tool_input: { why } } as never,
    undefined,
    { signal: new AbortController().signal },
  );

describe("request_homelab_access approval", () => {
  it("always asks, naming the project and the reason", async () => {
    expect(await run("Deploy the findmy server")).toMatchObject({
      hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: "Turn on homelab access for findmy-tag. Deploy the findmy server." },
    });
  });

  it("still asks without a reason", async () => {
    expect(await run(undefined)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: "Turn on homelab access for findmy-tag." },
    });
  });
});
