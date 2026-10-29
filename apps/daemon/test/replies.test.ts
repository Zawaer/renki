import { describe, expect, it } from "vitest";
import { SUGGEST_REPLIES_TOOL, createRepliesStopHook } from "../src/claude/replies.js";

const run = (extra: Record<string, unknown> = {}) =>
  createRepliesStopHook().hooks[0]!(
    { hook_event_name: "PostToolUse", tool_name: SUGGEST_REPLIES_TOOL, tool_input: {}, tool_response: {}, session_id: "s", transcript_path: "", cwd: "/", ...extra } as never,
    "toolu_1",
    { signal: new AbortController().signal },
  );

describe("createRepliesStopHook", () => {
  it("ends the turn once the buttons are shown, so Claude can't write the reply again", async () => {
    expect(await run()).toMatchObject({ continue: false });
  });

  it("lets a subagent that calls it carry on", async () => {
    expect(await run({ agent_id: "a1" })).toEqual({ continue: true });
  });
});
