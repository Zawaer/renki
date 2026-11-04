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

describe("move_into_repo approval note", () => {
  it("adds what the manager wants the user to know to the card", async () => {
    const out = await createMoveIntoRepoHook(async () => "It will lose homelab access.").hooks[0]!(
      { hook_event_name: "PreToolUse", tool_name: MOVE_INTO_REPO_TOOL, tool_input: { repo: "life-api" } } as never,
      undefined,
      { signal: new AbortController().signal },
    );
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecisionReason: "Move this chat into life-api. It will lose homelab access." } });
  });
});
