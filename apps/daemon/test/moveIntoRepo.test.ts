import { describe, expect, it } from "vitest";
import { MOVE_INTO_REPO_TOOL, createMoveIntoRepoHook } from "../src/claude/moveIntoRepo.js";

describe("move_into_repo approval", () => {
  it("always asks, naming the repo", async () => {
    const out = await createMoveIntoRepoHook().hooks[0]!(
      { hook_event_name: "PreToolUse", tool_name: MOVE_INTO_REPO_TOOL, tool_input: { repo: "Zawaer/life-api" } } as never,
      undefined,
      { signal: new AbortController().signal },
    );
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: "Move this chat into Zawaer/life-api." } });
  });
});
